import { describe, expect, it } from 'vitest';

import { normalizeQuickRoute } from './types';

/**
 * La Fase 21 fusionó "Carbos" y "Rápida" en "Comida". Estos tests fijan que
 * los identificadores viejos sigan funcionando: la notificación pegajosa que
 * ya está en la bandeja del teléfono fue creada por un build anterior y sus
 * botones siguen emitiendo `carbs`/`rapid`. Si esto se rompe, el botón deja
 * de hacer nada y no hay forma de enterarse desde el código.
 */
describe('normalizeQuickRoute', () => {
  it('traduce los destinos viejos a Comida', () => {
    expect(normalizeQuickRoute('carbs')).toBe('meal');
    expect(normalizeQuickRoute('rapid')).toBe('meal');
  });

  it('deja pasar los actuales sin tocarlos', () => {
    expect(normalizeQuickRoute('meal')).toBe('meal');
    expect(normalizeQuickRoute('basal')).toBe('basal');
    expect(normalizeQuickRoute('correction')).toBe('correction');
  });

  it('basal y corrección NO se fusionaron', () => {
    // Corrección es una acción clínica aparte, no ligada a un plato, y basal
    // no pertenece a ninguna comida. Fusionarlas sería el error opuesto.
    expect(normalizeQuickRoute('basal')).not.toBe('meal');
    expect(normalizeQuickRoute('correction')).not.toBe('meal');
  });
});
