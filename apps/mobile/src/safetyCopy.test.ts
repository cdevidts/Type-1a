import { describe, expect, it } from 'vitest';

/**
 * El texto de la app es superficie de seguridad, no decoración.
 *
 * Durante meses la copia visible decía, en seis pantallas distintas, que
 * Type 1A **no** calcula insulina activa. El 2026-09-02 empezó a calcularla
 * (ADR 0005) y esas seis frases pasaron a ser falsas de golpe: una de ellas
 * vivía en la misma pantalla que ahora sí descuenta unidades, y otra iba
 * impresa en el reporte que se le entrega al equipo clínico.
 *
 * Ninguna prueba lo detectó, porque una promesa vieja no rompe nada: sigue
 * compilando, sigue pasando, y solo miente. Este test es el que faltaba.
 *
 * No verifica cómo está redactada cada pantalla —eso es del diseño— sino que
 * ninguna afirme lo contrario de lo que el código hace.
 */

/**
 * Todo el código de la app como texto plano, resuelto por Vite en tiempo de
 * compilación del test. Se hace así y no con `fs` porque `apps/mobile` no
 * carga los tipos de Node: el `tsconfig` declara `react` y `react-native` y
 * nada más, a propósito.
 */
type RawGlob = {
  glob: (patterns: string[], options: { query: string; import: string; eager: true }) => Record<string, string>;
};
// El cast es porque `apps/mobile` no carga `vite/client` en sus tipos, y
// agregarlo solo por este test le abriría los tipos de DOM/Vite a toda la app.
const SOURCES: Record<string, string> = (import.meta as unknown as RawGlob).glob(
  ['./**/*.ts', './**/*.tsx', '../App.tsx'],
  { query: '?raw', import: 'default', eager: true },
);

/**
 * Frases que hoy serían falsas. Se buscan sin distinguir mayúsculas, sobre el
 * texto de todo `apps/mobile/src` y `App.tsx`.
 *
 * Si mañana se revierte el IOB, este test se borra junto con `iob.ts` — no se
 * "arregla" quitándole entradas para que pase.
 */
const CLAIMS_THAT_ARE_NOW_FALSE = [
  'no calcula insulina activa',
  'no calcula iob',
  'no estima insulina activa',
  'tampoco descuenta insulina activa',
  'no descuenta insulina activa (iob) de dosis anteriores',
  'ni resta dosis anteriores',
];

describe('la copia visible no promete lo contrario de lo que la app hace', () => {
  const files = Object.entries(SOURCES).filter(([path]) => !/\.test\.tsx?$/.test(path));

  it('encuentra archivos que revisar', () => {
    // Un glob roto haría que este test pase sin mirar nada.
    expect(files.length).toBeGreaterThan(30);
    expect(files.map(([path]) => path)).toContain('../App.tsx');
  });

  it.each(CLAIMS_THAT_ARE_NOW_FALSE)('ninguna pantalla dice "%s"', (claim) => {
    const offenders = files.filter(([, text]) => text.toLowerCase().includes(claim)).map(([path]) => path);
    expect(offenders, `Desde el ADR 0005 la app SÍ estima insulina activa. Corrige el texto en:\n${offenders.join('\n')}`)
      .toEqual([]);
  });

  it('la pantalla que descuenta explica de qué mitad lo descuenta', () => {
    // La regla que no se puede relajar: el IOB sale de la corrección, nunca
    // de los carbohidratos. Si eso deja de estar escrito en el desglose, la
    // usuaria no tiene cómo auditar el número que se va a inyectar.
    const breakdown = SOURCES['./components/InsulinBreakdown.tsx'];
    expect(breakdown).toBeDefined();
    expect(breakdown).toContain('solo de la corrección');
    expect(breakdown).toContain('Ajustes → Terapia');
  });
});
