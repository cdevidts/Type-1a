import { useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import ChevronDown from 'lucide-react-native/icons/chevron-down';
import ChevronRight from 'lucide-react-native/icons/chevron-right';

import { colors, radius, spacing } from '../theme';

/**
 * Una sección del Modal Maestro.
 *
 * ## Qué resuelve
 *
 * `projectbrief.md` fija que "Nueva entrada" y todos los modales de edición
 * consumen un mismo componente con toda la potencia de los accesos rápidos, y
 * que las herramientas aparecen **condicionalmente, por contenido**. Eso exige
 * que el mismo formulario pueda abrirse mostrando una sola cosa (viene del
 * botón "Basal": ella quiere anotar basal y cerrar) o mostrándolo todo.
 *
 * La alternativa —un modal por combinación— es exactamente lo que produjo
 * cuatro formularios divergentes y la Fase 21 entera. Acá la diferencia entre
 * "acceso rápido" y "entrada completa" es **qué secciones arrancan abiertas**,
 * no qué componente se monta.
 *
 * ## Reglas que respeta
 *
 * - El encabezado es tocable en toda su fila y llega a 44 pt
 *   (`contracts/ux-checklist.md`).
 * - **El estado plegado no se comunica solo con el chevron**: lleva el resumen
 *   de lo que hay adentro, así que se sabe si tiene datos sin abrirla.
 * - Una sección con contenido **no se puede plegar hasta esconderlo**: si trae
 *   datos, arranca abierta y su resumen los nombra. Un dato clínico escondido
 *   detrás de un acordeón es un dato que se olvida.
 */
export function EntrySection({
  title,
  /** Qué hay adentro, para leerlo sin abrir. `null` = vacía. */
  summary,
  /** Abierta de entrada. El maestro la calcula desde el foco y el sujeto. */
  initiallyOpen,
  children,
}: {
  title: string;
  summary?: string | null;
  initiallyOpen: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <View style={styles.section}>
      <Pressable
        style={styles.header}
        onPress={() => { setOpen((previous) => !previous); }}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`${title}. ${summary ?? 'sin datos'}. ${open ? 'Contraer' : 'Expandir'}`}
        hitSlop={8}
      >
        <Chevron size={18} color={colors.navy} />
        <Text style={styles.title}>{title}</Text>
        {open || summary === null || summary === undefined
          ? null
          : <Text style={styles.summary} numberOfLines={1}>{summary}</Text>}
      </Pressable>
      {open ? <View style={styles.body}>{children}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { marginTop: spacing.lg },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: 44,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.sm,
    backgroundColor: colors.surface,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.line,
  },
  title: { color: colors.navy, fontSize: 14, fontWeight: '800' },
  // `flexShrink` de los dos lados: con un título corto y un resumen largo en
  // la misma fila, sin esto el título se parte letra por letra.
  summary: { color: colors.muted, fontSize: 12, flexShrink: 1, marginLeft: 'auto' },
  body: { marginTop: spacing.sm },
});
