import { describe, expect, it } from 'vitest';

import {
  DICTATION_HINT_LIMIT,
  DICTATION_MAX_CHARS,
  dictationHints,
  dictationRunsOnDevice,
  dictationStartOptions,
  mergeDictation,
  pickDictationLocale,
} from './dictation';

describe('mergeDictation', () => {
  it('escribe en un cuadro vacío sin espacio de más', () => {
    expect(mergeDictation('', 'comí un plato de tallarines')).toBe('comí un plato de tallarines');
  });

  it('separa con un espacio de lo que ella ya había escrito', () => {
    expect(mergeDictation('estoy en 180', 'y me voy a comer una manzana')).toBe(
      'estoy en 180 y me voy a comer una manzana',
    );
  });

  it('no duplica el espacio que ella dejó a propósito', () => {
    expect(mergeDictation('estoy en 180 ', 'y comí')).toBe('estoy en 180 y comí');
  });

  it('un resultado parcial REEMPLAZA al anterior, no se acumula', () => {
    // El reconocedor manda la transcripción entera en cada evento. Concatenar
    // daría "doscientos doscientos sesenta doscientos sesenta y cuatro".
    const base = 'glucosa';
    expect(mergeDictation(base, 'doscientos')).toBe('glucosa doscientos');
    expect(mergeDictation(base, 'doscientos sesenta')).toBe('glucosa doscientos sesenta');
    expect(mergeDictation(base, 'doscientos sesenta y cuatro')).toBe(
      'glucosa doscientos sesenta y cuatro',
    );
  });

  it('un dictado vacío no ensucia lo escrito con un espacio colgando', () => {
    // Pasaría al soltar el botón sin haber dicho nada: el cuadro tiene que
    // quedar igual que antes, no con un espacio nuevo al final.
    expect(mergeDictation('estoy en 180', '')).toBe('estoy en 180');
    expect(mergeDictation('estoy en 180', '   ')).toBe('estoy en 180');
    expect(mergeDictation('', '')).toBe('');
  });

  it('recorta al tope del contrato del chat', () => {
    const largo = 'a'.repeat(DICTATION_MAX_CHARS + 500);
    expect(mergeDictation('', largo)).toHaveLength(DICTATION_MAX_CHARS);
    expect(mergeDictation('a'.repeat(DICTATION_MAX_CHARS), 'y más')).toHaveLength(
      DICTATION_MAX_CHARS,
    );
  });
});

describe('dictationHints', () => {
  const insulinNames = ['Fiasp', 'Tresiba'];
  const foodNames = ['porotos granados', 'marraqueta'];

  it('NO manda nombres de insulina ni de comida a un reconocedor de red', () => {
    // La prueba de la regla: el nombre de una insulina revela que quien habla
    // es diabético y con qué se trata. Que la lista viaje al servicio de
    // dictado de un tercero es la fuga que prohíbe el ADR 0007.
    expect(dictationHints({ onDevice: false, insulinNames, foodNames })).toEqual([]);
  });

  it('sí las usa cuando la transcripción ocurre en el teléfono', () => {
    expect(dictationHints({ onDevice: true, insulinNames, foodNames })).toEqual([
      'Fiasp',
      'Tresiba',
      'porotos granados',
      'marraqueta',
    ]);
  });

  it('pone las insulinas antes que las comidas', () => {
    const hints = dictationHints({
      onDevice: true,
      insulinNames: ['Lantus'],
      foodNames: Array.from({ length: DICTATION_HINT_LIMIT }, (_, i) => `comida ${i}`),
    });
    expect(hints[0]).toBe('Lantus');
    expect(hints).toHaveLength(DICTATION_HINT_LIMIT);
  });

  it('no repite un nombre por diferencia de mayúsculas', () => {
    const hints = dictationHints({
      onDevice: true,
      insulinNames: ['Fiasp'],
      foodNames: ['fiasp', 'FIASP', 'marraqueta'],
    });
    expect(hints).toEqual(['Fiasp', 'marraqueta']);
  });

  it('descarta lo que es ruido y no una pista', () => {
    const hints = dictationHints({
      onDevice: true,
      insulinNames: ['  ', 'ok'],
      foodNames: ['  pan  ', ''],
    });
    expect(hints).toEqual(['pan']);
  });
});

describe('pickDictationLocale', () => {
  it('prefiere el español de Chile cuando está', () => {
    expect(pickDictationLocale(['en-US', 'es-MX', 'es-CL', 'pt-BR'])).toBe('es-CL');
  });

  it('acepta cualquier otro español antes que quedarse sin idioma', () => {
    expect(pickDictationLocale(['en-US', 'es-MX'])).toBe('es-MX');
    expect(pickDictationLocale(['es'])).toBe('es');
  });

  it('normaliza el guion bajo que devuelve Android', () => {
    expect(pickDictationLocale(['es_CL'])).toBe('es-CL');
  });

  it('no confunde un idioma que apenas empieza con "es"', () => {
    // "et-EE" (estonio) y "eu-ES" (euskera) no son español.
    expect(pickDictationLocale(['et-EE', 'eu-ES'])).toBeUndefined();
  });

  it('sin español devuelve undefined en vez de forzar uno que no existe', () => {
    expect(pickDictationLocale(['en-US', 'fr-FR'])).toBeUndefined();
    expect(pickDictationLocale([])).toBeUndefined();
  });
});

describe('dictationRunsOnDevice', () => {
  it('exige el modelo instalado, no solo que el teléfono lo soporte', () => {
    // El bug clásico: soportar reconocimiento local y no tener descargado el
    // español deja el micrófono mudo con `language-not-supported`.
    expect(dictationRunsOnDevice(true, [])).toBe(false);
    expect(dictationRunsOnDevice(true, ['en-US'])).toBe(false);
    expect(dictationRunsOnDevice(true, ['es-CL'])).toBe(true);
  });

  it('es falso si el teléfono no sabe transcribir sin red', () => {
    expect(dictationRunsOnDevice(false, ['es-CL'])).toBe(false);
  });
});

describe('dictationStartOptions', () => {
  const names = { insulinNames: ['Fiasp'], foodNames: ['marraqueta'] };

  it('nunca deja salir el vocabulario sin exigir transcripción local', () => {
    // La invariante entera de la Fase 4, en una línea: si el audio va a la red,
    // la lista de pistas va vacía. Están acopladas para que no se puedan
    // desincronizar por una edición futura.
    for (const onDevice of [true, false]) {
      const options = dictationStartOptions({ onDevice, ...names });
      if (!options.requiresOnDeviceRecognition) {
        expect(options.contextualStrings).toEqual([]);
      }
    }
  });

  it('con transcripción local pasa las pistas y la puntuación', () => {
    const options = dictationStartOptions({ onDevice: true, locale: 'es-CL', ...names });
    expect(options).toEqual({
      lang: 'es-CL',
      requiresOnDeviceRecognition: true,
      addsPunctuation: true,
      contextualStrings: ['Fiasp', 'marraqueta'],
    });
  });

  it('omite el idioma en vez de mandar undefined', () => {
    // `exactOptionalPropertyTypes`: para omitir hay que omitir la clave.
    expect('lang' in dictationStartOptions({ onDevice: false, ...names })).toBe(false);
  });
});
