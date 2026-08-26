import { Component, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { logSaveError } from '../log';
import { colors, radius, spacing } from '../theme';

/**
 * Frontera de error para una pantalla.
 *
 * Sin esto, una excepción lanzada **durante el render** (no dentro de un
 * `await`, donde el `.catch()` la agarra) desmonta el árbol de React entero:
 * la app queda inservible y solo se recupera cerrándola por completo. Es
 * exactamente el síntoma que Verónica reportó en el Resumen —
 * ver el tag `archive/pre-memory-bank`, § Fase 13, ítem 5.
 *
 * Los cálculos de `packages/domain` lanzan a propósito cuando reciben algo
 * que no pueden interpretar (`convertGlucose` con un valor no positivo,
 * `percentile` con una muestra vacía). Eso es correcto y **no se relaja**:
 * más vale no mostrar un número que mostrar uno inventado. Lo que arregla
 * esta frontera es la consecuencia desproporcionada — que un dato ilegible
 * en una pantalla tumbe la app entera, incluidos el registro de glucosa y
 * las alarmas.
 *
 * El stack real va a `logSaveError`, que ya está acotado a
 * `name`/`message` para no violar la regla de `AGENTS.md` de no loguear
 * datos de glucosa, insulina o comida.
 */
export class ErrorBoundary extends Component<
  { children: ReactNode; title: string; body: string; onReset?: () => void },
  { hasError: boolean }
> {
  override state = { hasError: false };

  static getDerivedStateFromError(): { hasError: boolean } {
    return { hasError: true };
  }

  override componentDidCatch(error: unknown): void {
    logSaveError('ErrorBoundary', error);
  }

  private handleReset = (): void => {
    this.setState({ hasError: false });
    this.props.onReset?.();
  };

  override render(): ReactNode {
    if (!this.state.hasError) return this.props.children;
    return (
      <View style={styles.container}>
        <Text style={styles.title}>{this.props.title}</Text>
        <Text style={styles.body}>{this.props.body}</Text>
        <Text style={styles.reassurance}>
          Tus registros están intactos: esto solo afectó a lo que se estaba mostrando en pantalla.
        </Text>
        <Pressable
          style={styles.button}
          onPress={this.handleReset}
          accessibilityRole="button"
          accessibilityLabel="Reintentar"
        >
          <Text style={styles.buttonText}>Reintentar</Text>
        </Pressable>
      </View>
    );
  }
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: spacing.lg,
    margin: spacing.lg,
    gap: spacing.sm,
  },
  title: { color: colors.ink, fontSize: 15, fontWeight: '800', textAlign: 'center' },
  body: { color: colors.muted, fontSize: 13, lineHeight: 19, textAlign: 'center' },
  reassurance: { color: colors.muted, fontSize: 12, lineHeight: 18, textAlign: 'center' },
  button: {
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.sm,
    backgroundColor: colors.teal,
    marginTop: spacing.sm,
  },
  buttonText: { color: colors.surface, fontSize: 15, fontWeight: '800' },
});
