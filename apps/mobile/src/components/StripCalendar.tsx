import { useEffect, useRef } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import ChevronLeft from 'lucide-react-native/icons/chevron-left';
import ChevronRight from 'lucide-react-native/icons/chevron-right';

import { isSameDay, monthDays, monthLabel } from '../entryTime';
import { colors, radius, spacing } from '../theme';

/**
 * La fila de días de Nutrición.
 *
 * ## Qué resuelve
 *
 * Nutrición estaba clavada en "hoy": `onLoadDay` no recibía fecha y las
 * consultas se filtraban contra `new Date()`. Revisar lo que se comió ayer
 * —que es *la* razón por la que existe una pantalla de nutrición— no se podía.
 *
 * ## Reglas de accesibilidad que no son opcionales
 *
 * - **El día seleccionado no se marca solo con color.** Lleva relleno, borde
 *   más grueso, peso de fuente y, sobre todo, `accessibilityState.selected` y
 *   una etiqueta que dice la fecha completa. Un círculo teal entre veinte
 *   círculos grises es exactamente el estado que se pierde
 *   (`contracts/ux-checklist.md`).
 * - **Los días futuros se muestran deshabilitados, no se esconden.** Una fila
 *   que se corta en hoy se lee como si el mes terminara ahí. Van en gris, con
 *   `accessibilityState.disabled` y sin poder tocarse: registrar en el futuro
 *   contamina episodios y ventanas de patrones.
 * - Cada círculo mide 44 pt.
 *
 * Toda la aritmética de calendario está en `entryTime.ts`, pura y con test:
 * fin de mes, cambio de año y "hoy a las 23:59" son casos que hay que probar,
 * no mirar.
 */

export function StripCalendar({
  year,
  month,
  selected,
  onSelect,
  onChangeMonth,
  onToday,
  now = new Date(),
}: {
  year: number;
  /** 0-11, como en `Date`. */
  month: number;
  selected: Date;
  onSelect: (date: Date) => void;
  onChangeMonth: (delta: number) => void;
  onToday: () => void;
  now?: Date;
}) {
  const days = monthDays(year, month, now);
  const scrollRef = useRef<ScrollView>(null);
  const selectedIndex = days.findIndex((day) => isSameDay(day.date, selected));

  // Traer el día elegido a la vista al abrir y al cambiar de mes. Sin esto,
  // seleccionar el 28 y volver al mes anterior deja la fila en el día 1 y
  // parece que no pasó nada.
  useEffect(() => {
    if (selectedIndex < 0) return;
    const offset = Math.max(0, (selectedIndex - 2) * (DAY_WIDTH + spacing.sm));
    scrollRef.current?.scrollTo({ x: offset, animated: false });
  }, [selectedIndex, year, month]);

  const isCurrentMonth = now.getFullYear() === year && now.getMonth() === month;

  return (
    <View style={styles.wrap}>
      <View style={styles.monthRow}>
        <Pressable
          style={styles.monthButton}
          onPress={() => { onChangeMonth(-1); }}
          accessibilityRole="button"
          accessibilityLabel="Mes anterior"
          hitSlop={8}
        >
          <ChevronLeft size={20} color={colors.navy} />
        </Pressable>
        <Text style={styles.monthLabel}>{monthLabel(year, month)}</Text>
        <Pressable
          style={[styles.monthButton, isCurrentMonth && styles.monthButtonDisabled]}
          onPress={() => { onChangeMonth(1); }}
          disabled={isCurrentMonth}
          accessibilityRole="button"
          accessibilityLabel="Mes siguiente"
          accessibilityState={{ disabled: isCurrentMonth }}
          hitSlop={8}
        >
          <ChevronRight size={20} color={isCurrentMonth ? colors.line : colors.navy} />
        </Pressable>
        <Pressable
          style={styles.todayButton}
          onPress={onToday}
          accessibilityRole="button"
          accessibilityLabel="Volver a hoy"
          hitSlop={8}
        >
          <Text style={styles.todayText}>Hoy</Text>
        </Pressable>
      </View>

      <ScrollView
        ref={scrollRef}
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.strip}
      >
        {days.map((day) => {
          const isSelected = isSameDay(day.date, selected);
          return (
            <Pressable
              key={day.dayOfMonth}
              style={[
                styles.day,
                day.isToday && styles.dayToday,
                isSelected && styles.daySelected,
                day.isFuture && styles.dayFuture,
              ]}
              disabled={day.isFuture}
              onPress={() => { onSelect(day.date); }}
              accessibilityRole="button"
              accessibilityState={{ selected: isSelected, disabled: day.isFuture }}
              accessibilityLabel={
                `${day.dayOfMonth} de ${monthLabel(year, month)}`
                + (day.isToday ? ', hoy' : '')
                + (day.isFuture ? ', todavía no ha pasado' : '')
              }
            >
              <Text style={[styles.dayLetter, isSelected && styles.dayTextSelected, day.isFuture && styles.dayTextFuture]}>
                {day.letter}
              </Text>
              <Text style={[styles.dayNumber, isSelected && styles.dayTextSelected, day.isFuture && styles.dayTextFuture]}>
                {day.dayOfMonth}
              </Text>
              {/*
                El punto NO es lo que comunica la selección — la comunican el
                relleno, el peso de la fuente y `accessibilityState`. Es un
                refuerzo redundante, que es justo lo que pide la regla.
              */}
              {isSelected ? <View style={styles.selectedDot} /> : null}
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

const DAY_WIDTH = 44;

const styles = StyleSheet.create({
  wrap: { borderBottomColor: colors.line, borderBottomWidth: StyleSheet.hairlineWidth, paddingBottom: spacing.sm },
  monthRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.lg, paddingTop: spacing.sm },
  monthButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  monthButtonDisabled: { opacity: 0.4 },
  monthLabel: { flex: 1, color: colors.ink, fontSize: 15, fontWeight: '800', textTransform: 'capitalize' },
  todayButton: { minHeight: 44, justifyContent: 'center', paddingHorizontal: spacing.md, borderRadius: radius.sm, backgroundColor: colors.tealSoft },
  todayText: { color: colors.teal, fontSize: 13, fontWeight: '800' },
  strip: { paddingHorizontal: spacing.lg, gap: spacing.sm },
  day: {
    width: DAY_WIDTH,
    minHeight: 60,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
    paddingVertical: spacing.xs,
  },
  dayToday: { borderColor: colors.teal },
  daySelected: { backgroundColor: colors.teal, borderColor: colors.teal, borderWidth: 2 },
  dayFuture: { backgroundColor: colors.background, borderColor: colors.line },
  dayLetter: { color: colors.muted, fontSize: 10, fontWeight: '800' },
  dayNumber: { color: colors.ink, fontSize: 16, fontWeight: '700', marginTop: 1 },
  dayTextSelected: { color: '#FFFFFF', fontWeight: '900' },
  dayTextFuture: { color: colors.line },
  selectedDot: { width: 4, height: 4, borderRadius: 2, backgroundColor: '#FFFFFF', marginTop: 2 },
});
