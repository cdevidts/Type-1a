import { describe, expect, it } from 'vitest';

import { insulinNameForType, insulinPurposeForEntry, resolveInsulinNameForEdit, resolveInsulinPurposeForEdit } from '../src/index';

/**
 * El nombre de la insulina dejó de ser un campo de texto por registro.
 *
 * Los cuatro modos de perderlo que estos tests fijan, cada uno con su fallo
 * concreto detrás:
 *
 * 1. Una actualización parcial que no lo pasaba lo borraba en silencio
 *    (`updateUnifiedEntryGroup` llamaba a `updateInsulinEvent` sin él, y aquel
 *    lo asignaba incondicionalmente).
 * 2. Reclasificar rápida ↔ basal dejaba encima el nombre del tipo anterior.
 * 3. Un evento importado se "normalizaba" contra la configuración de hoy,
 *    perdiendo lo que decía su fuente.
 * 4. Sin configuración, se inventaba un nombre de relleno — que en el reporte
 *    médico se lee como un dato que alguien escribió.
 */

const perfil = { rapidInsulinName: 'Fiasp', basalInsulinName: 'Tresiba' };

describe('insulinNameForType', () => {
  it('devuelve el nombre del tipo que corresponde', () => {
    expect(insulinNameForType(perfil, 'rapid')).toBe('Fiasp');
    expect(insulinNameForType(perfil, 'basal')).toBe('Tresiba');
  });

  it('sin configuración devuelve undefined y NO inventa un nombre', () => {
    expect(insulinNameForType({}, 'rapid')).toBeUndefined();
    expect(insulinNameForType({}, 'basal')).toBeUndefined();
  });

  it('un nombre en blanco cuenta como no configurado', () => {
    expect(insulinNameForType({ rapidInsulinName: '   ' }, 'rapid')).toBeUndefined();
  });

  it('recorta los espacios: "Fiasp " y "Fiasp" son la misma insulina', () => {
    expect(insulinNameForType({ rapidInsulinName: ' Fiasp ' }, 'rapid')).toBe('Fiasp');
  });
});

describe('resolveInsulinNameForEdit', () => {
  it('editar sin cambiar el tipo CONSERVA el nombre guardado', () => {
    expect(resolveInsulinNameForEdit({
      source: 'manual',
      existingName: 'Humalog',
      previousType: 'rapid',
      nextType: 'rapid',
      profile: perfil,
    })).toBe('Humalog');
  });

  it('una dosis sin nombre toma el del perfil al editarla', () => {
    expect(resolveInsulinNameForEdit({
      source: 'manual',
      previousType: 'rapid',
      nextType: 'rapid',
      profile: perfil,
    })).toBe('Fiasp');
  });

  it('cambiar rápida → basal reestampa con el nombre de la basal', () => {
    expect(resolveInsulinNameForEdit({
      source: 'manual',
      existingName: 'Fiasp',
      previousType: 'rapid',
      nextType: 'basal',
      profile: perfil,
    })).toBe('Tresiba');
  });

  it('cambiar basal → rápida reestampa con el nombre de la rápida', () => {
    expect(resolveInsulinNameForEdit({
      source: 'manual',
      existingName: 'Tresiba',
      previousType: 'basal',
      nextType: 'rapid',
      profile: perfil,
    })).toBe('Fiasp');
  });

  it('un evento IMPORTADO conserva estrictamente el nombre de su fuente', () => {
    expect(resolveInsulinNameForEdit({
      source: 'imported',
      existingName: 'NovoRapid (CSV)',
      previousType: 'rapid',
      nextType: 'rapid',
      profile: perfil,
    })).toBe('NovoRapid (CSV)');
  });

  it('un importado sin nombre tampoco recibe uno del perfil', () => {
    expect(resolveInsulinNameForEdit({
      source: 'imported',
      previousType: 'rapid',
      nextType: 'rapid',
      profile: perfil,
    })).toBeUndefined();
  });

  it('sin perfil configurado y sin nombre previo, queda sin nombre', () => {
    expect(resolveInsulinNameForEdit({
      source: 'manual',
      previousType: 'basal',
      nextType: 'basal',
      profile: {},
    })).toBeUndefined();
  });

  /**
   * El historial no se reescribe cuando cambia la configuración: si el tipo no
   * cambió, lo guardado manda sobre el perfil de hoy.
   */
  it('cambiar de tratamiento no reescribe el historial antiguo', () => {
    expect(resolveInsulinNameForEdit({
      source: 'manual',
      existingName: 'Humalog',
      previousType: 'rapid',
      nextType: 'rapid',
      profile: { rapidInsulinName: 'Lyumjev' },
    })).toBe('Humalog');
  });
});

describe('insulinPurposeForEntry', () => {
  it('deriva los tres propósitos descriptivos posibles de una rápida', () => {
    expect(insulinPurposeForEntry('rapid', true, false)).toBe('meal');
    expect(insulinPurposeForEntry('rapid', true, true)).toBe('combined');
    expect(insulinPurposeForEntry('rapid', false, true)).toBe('correction');
  });

  it('una basal nunca conserva propósito de comida o corrección', () => {
    expect(insulinPurposeForEntry('basal', true, true)).toBeUndefined();
    expect(insulinPurposeForEntry('basal', false, false)).toBeUndefined();
  });
});

describe('resolveInsulinPurposeForEdit', () => {
  it('editar una rápida sin cambiar el tipo conserva combined aunque el formulario no lo recuerde', () => {
    expect(resolveInsulinPurposeForEdit({
      existingPurpose: 'combined',
      previousType: 'rapid',
      nextType: 'rapid',
      hasMeal: true,
      includesCorrection: false,
    })).toBe('combined');
  });

  it('rápida → basal elimina cualquier propósito anterior', () => {
    expect(resolveInsulinPurposeForEdit({
      existingPurpose: 'meal',
      previousType: 'rapid',
      nextType: 'basal',
      hasMeal: true,
      includesCorrection: true,
    })).toBeUndefined();
  });

  it('basal → rápida deriva el propósito del contenido nuevo', () => {
    expect(resolveInsulinPurposeForEdit({
      previousType: 'basal',
      nextType: 'rapid',
      hasMeal: true,
      includesCorrection: true,
    })).toBe('combined');
  });
});

describe('el nombre sale del catálogo cuando se eligió de la lista (2026-09-02)', () => {
  // El bug: Ajustes guarda `rapidInsulinId`, y `rapidInsulinName` era un campo
  // que ninguna pantalla llenaba. Quien elegía Fiasp de la lista veía "sin
  // configurar" en Nueva entrada, y sus dosis quedaban guardadas sin marca.
  it('deriva la marca del id elegido', () => {
    expect(insulinNameForType({ rapidInsulinId: 'fiasp' }, 'rapid')).toBe('Fiasp');
    expect(insulinNameForType({ basalInsulinId: 'tresiba' }, 'basal')).toBe('Tresiba');
  });

  it('lo escrito a mano manda sobre el catálogo', () => {
    expect(insulinNameForType({ rapidInsulinId: 'fiasp', rapidInsulinName: 'La mía' }, 'rapid')).toBe('La mía');
    // Un nombre en blanco no cuenta como escrito: cae al catálogo.
    expect(insulinNameForType({ rapidInsulinId: 'fiasp', rapidInsulinName: '   ' }, 'rapid')).toBe('Fiasp');
  });

  it('no cruza categorías: una basal no se estampa como rápida', () => {
    expect(insulinNameForType({ rapidInsulinId: 'tresiba' }, 'rapid')).toBeUndefined();
    expect(insulinNameForType({ basalInsulinId: 'fiasp' }, 'basal')).toBeUndefined();
  });

  it('sin nada configurado sigue devolviendo undefined: no inventa un nombre', () => {
    expect(insulinNameForType({}, 'rapid')).toBeUndefined();
    expect(insulinNameForType({ rapidInsulinId: 'no-existe' }, 'rapid')).toBeUndefined();
  });
});
