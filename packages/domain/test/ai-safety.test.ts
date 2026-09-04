import { describe, expect, it } from 'vitest';

import {
  containsTherapyRecommendation,
  isPlainWaterFood,
  separatePlainWater,
  requestsInsulinAdvice,
  waterEstimateIsTrustworthy,
} from '../src/ai-safety';

describe('containsTherapyRecommendation', () => {
  it('rechaza una salida que recomienda dosis', () => {
    expect(containsTherapyRecommendation('Deberías ponerte más insulina.')).toBe(true);
    expect(containsTherapyRecommendation('Ajusta tu ratio de carbohidratos.')).toBe(true);
    expect(containsTherapyRecommendation({ summary: 'Ponte 2 unidades más.' })).toBe(true);
  });

  it('deja pasar una descripción de lo que pasó', () => {
    expect(containsTherapyRecommendation('La glucosa subió a 210 mg/dL a los 60 minutos.')).toBe(false);
    expect(containsTherapyRecommendation({ foods: [{ name: 'Pan integral', carbsG: 24 }] })).toBe(false);
  });
});

describe('requestsInsulinAdvice', () => {
  it('rechaza una instrucción de edición que pide calcular insulina', () => {
    // El caso que motiva la función: son preguntas, no recomendaciones, así
    // que el filtro de salida no las ve.
    expect(requestsInsulinAdvice('¿cuánta insulina me pongo con esto?')).toBe(true);
    expect(requestsInsulinAdvice('cuántas unidades necesito')).toBe(true);
    expect(requestsInsulinAdvice('calcula el bolo para esta comida')).toBe(true);
    expect(requestsInsulinAdvice('sugiéreme una corrección')).toBe(true);
    expect(requestsInsulinAdvice('qué dosis corresponde')).toBe(true);
    expect(requestsInsulinAdvice('¿cuánto me pongo?')).toBe(true);
    expect(requestsInsulinAdvice('debo ponerme algo antes de comer?')).toBe(true);
    expect(requestsInsulinAdvice('how much insulin should I take')).toBe(true);
  });

  it('deja pasar una edición legítima de la comida', () => {
    expect(requestsInsulinAdvice('agrégale una cucharada de aceite')).toBe(false);
    expect(requestsInsulinAdvice('en realidad fue media porción')).toBe(false);
    expect(requestsInsulinAdvice('esto era pan integral, no blanco')).toBe(false);
    expect(requestsInsulinAdvice('sácale el arroz y déjale solo el pollo')).toBe(false);
    expect(requestsInsulinAdvice('eran dos huevos, no uno')).toBe(false);
  });

  it('no confunde una nota emocional con una pregunta de dosis', () => {
    // "me pongo" suelto no alcanza: aparece en notas legítimas, y rechazar
    // esta edición sería un falso positivo que la usuaria no entendería.
    expect(requestsInsulinAdvice('me pongo nerviosa antes de comer, agrégalo a la nota')).toBe(false);
  });
});

describe('insulina activa (IOB) en la salida — agregado tras la revisión de la Fase 23', () => {
  // El prompt v3+ le pasa al modelo la lista de dosis de la ventana con sus
  // unidades y minutos. Con eso puede afirmar superposición sin recomendar
  // nada: "la segunda dosis se solapó con la primera, que todavía estaba
  // activa" es una descripción, y también es una estimación de insulina
  // activa — que `AGENTS.md` prohíbe en el MVP. Al crecer lo que el modelo
  // puede decir, crece el filtro.
  const iobClaims = [
    'La segunda dosis se solapó con la primera, que todavía estaba activa.',
    'Parte de la subida se explica porque aún había insulina activa.',
    'El bolo de las 13:00 seguía haciendo efecto a las 15:00.',
    'La dosis se quedó corta para la carga de la comida.',
    'Hizo falta más insulina para cubrir ese plato.',
    'La próxima vez conviene adelantar el bolo.',
  ];

  for (const claim of iobClaims) {
    it(`rechaza: "${claim}"`, () => {
      expect(containsTherapyRecommendation(claim)).toBe(true);
    });
  }

  // Contracara: describir lo que se registró, sin evaluarlo ni estimar
  // actividad residual, es exactamente lo que el insight SÍ debe poder decir.
  const descriptive = [
    'Se registró una dosis rápida de 2 U a las 2 horas.',
    'Se registraron 20 g de carbohidratos a los 90 minutos.',
    'La glucosa subió 62 mg/dL entre la comida y las 3 horas.',
    'Faltan lecturas entre las 2 y las 3 horas, así que el pico puede ser mayor.',
    'La próxima vez que haya más lecturas disponibles se podrá describir mejor el tramo.',
  ];

  for (const text of descriptive) {
    it(`deja pasar: "${text}"`, () => {
      expect(containsTherapyRecommendation(text)).toBe(false);
    });
  }
});

describe('juicio o consejo sobre la hora de comer (2026-09-01)', () => {
  // Hasta ahora el modelo recibía la hora en UTC, un dato sin significado para
  // la vida de quien registró la comida — ese era justo el bug que arregla
  // `episode-local-time.ts`. Ahora recibe la hora de pared local y el prompt
  // le dice que es la hora real de esa persona, así que por primera vez tiene
  // material para juzgarla. Al crecer lo que el modelo puede decir, crece el
  // filtro: es la misma regla que trajo los patrones de IOB de la Fase 23.
  const timingAdvice = [
    'La comida fue a las 21:30; cenar tan tarde suele dar picos más sostenidos. La próxima vez intenta cenar más temprano.',
    'Las cenas después de las 21:00 muestran picos más altos que las de las 19:00: conviene adelantar la cena.',
    'Sería mejor cenar antes de las 20:00.',
    'La cena fue demasiado tarde.',
    'Te recomiendo adelantar el almuerzo.',
    'Deberías comer más temprano.',
    'Procura no cenar tan tarde.',
  ];

  for (const claim of timingAdvice) {
    it(`rechaza: "${claim}"`, () => {
      expect(containsTherapyRecommendation(claim)).toBe(true);
    });
  }

  // Contracara: describir CUÁNDO pasó algo es el trabajo de este resumen, y
  // un falso positivo acá no cuesta un mensaje — cuesta el insight entero.
  const descriptiveTiming = [
    'La comida fue a las 17:30 y el pico llegó a los 75 minutos.',
    'Las cenas más tardías mostraron picos más altos que las del mediodía.',
    'El episodio empezó a las 13:05 con 118 mg/dL.',
    'Deberías anotar la fibra de esta comida para que el total no sea un mínimo.',
    'El pico llegó demasiado tarde para atribuirlo solo a los carbohidratos.',
    'Faltan lecturas entre las 2 y las 3 horas de la comida.',
  ];

  for (const text of descriptiveTiming) {
    it(`deja pasar: "${text}"`, () => {
      expect(containsTherapyRecommendation(text)).toBe(false);
    });
  }
});

describe('waterEstimateIsTrustworthy — el jugo no puede entrar como agua (2026-09-03)', () => {
  it('sin agua estimada no hay nada que desconfiar', () => {
    expect(waterEstimateIsTrustworthy({ waterMl: null, foodNames: ['Arroz'] })).toBe(true);
    expect(waterEstimateIsTrustworthy({ waterMl: undefined, foodNames: [] })).toBe(true);
  });

  it('agua sola con comida normal se acepta', () => {
    expect(waterEstimateIsTrustworthy({
      waterMl: 250, foodNames: ['Arroz', 'Pollo'], description: 'almuerzo con un vaso de agua',
    })).toBe(true);
  });

  it('EL CASO PELIGROSO: se nombra un jugo y ningún alimento lo recoge', () => {
    // Si esto pasara, ~25 g de carbohidratos desaparecen del registro y del
    // campo que alimenta el bolo. Perder el vaso de agua es una molestia;
    // perder los carbohidratos es una dosis corta.
    expect(waterEstimateIsTrustworthy({
      waterMl: 250, foodNames: ['Arroz', 'Pollo'], description: 'almuerzo con un jugo de naranja',
    })).toBe(false);
  });

  it('si el alimento SÍ recoge la bebida, el agua puede convivir con ella', () => {
    expect(waterEstimateIsTrustworthy({
      waterMl: 250,
      foodNames: ['Arroz', 'Jugo de naranja'],
      description: 'almuerzo con jugo y además agua',
    })).toBe(true);
  });

  it('atrapa la bebida aunque venga solo en los nombres del análisis', () => {
    expect(waterEstimateIsTrustworthy({ waterMl: 300, foodNames: ['Pan', 'leche entera'] })).toBe(true);
  });

  it.each([
    'un jugo', 'una bebida', 'gaseosa', 'leche', 'un café con leche', 'té con azúcar',
    'sopa de verduras', 'un batido', 'cerveza', 'a glass of juice', 'a soft drink', 'some milk',
  ])('desconfía cuando el texto dice "%s" y nada lo recoge', (text) => {
    expect(waterEstimateIsTrustworthy({ waterMl: 250, foodNames: ['Arroz'], description: text })).toBe(false);
  });
});

describe('separatePlainWater — el agua que el prompt v3 mete en foods (2026-09-03)', () => {
  const water = {
    name: 'Agua', estimatedGrams: 250, servingGrams: 250,
    carbsG: 0, proteinG: 0, fatG: 0, caloriesKcal: 0,
  };
  const rice = {
    name: 'Arroz con pollo', estimatedGrams: 350, servingGrams: 350,
    carbsG: 55, proteinG: 30, fatG: 12, caloriesKcal: 460,
  };

  it('EL CASO REAL del backend en v3: rescata el vaso y limpia el catálogo', () => {
    // Respuesta literal de producción a "arroz con pollo y un vaso de agua".
    const result = separatePlainWater([rice, water]);
    expect(result.foods).toEqual([rice]);
    expect(result.waterMl).toBe(250);
  });

  it('sin agua no toca nada', () => {
    expect(separatePlainWater([rice])).toEqual({ foods: [rice], waterMl: null });
  });

  it('UN AGUA CON CARBOHIDRATOS NO ES AGUA', () => {
    // Clasificar mal en esta dirección saca carbohidratos del plato y de la
    // dosis. El filtro prefiere dejar pasar un alimento raro antes que perder
    // un gramo.
    const cocoWater = { ...water, name: 'Agua de coco', carbsG: 9, caloriesKcal: 45 };
    expect(separatePlainWater([cocoWater]).foods).toHaveLength(1);
    expect(separatePlainWater([cocoWater]).waterMl).toBeNull();
    const sparkling = { ...water, name: 'Agua saborizada', carbsG: 6, caloriesKcal: 25 };
    expect(separatePlainWater([sparkling]).foods).toHaveLength(1);
  });

  it.each(['Agua', 'agua', 'AGUA', 'Agua mineral', 'Agua sin gas', 'un vaso de agua', 'Water'])(
    'reconoce "%s" como agua sola', (name) => {
      expect(isPlainWaterFood({ ...water, name })).toBe(true);
    },
  );

  it.each(['Jugo de naranja', 'Leche', 'Sopa de verduras', 'Café', 'Agua de coco', 'Arroz'])(
    'NO trata "%s" como agua', (name) => {
      expect(isPlainWaterFood({ ...water, name, carbsG: name === 'Café' ? 0 : 5 })).toBe(false);
    },
  );

  it('suma varios vasos y redondea', () => {
    const result = separatePlainWater([water, rice, { ...water, estimatedGrams: 330 }]);
    expect(result.waterMl).toBe(580);
    expect(result.foods).toEqual([rice]);
  });

  it('agua sin volumen estimable no inventa un número', () => {
    const result = separatePlainWater([{ ...water, estimatedGrams: null, servingGrams: null }]);
    expect(result.waterMl).toBeNull();
    expect(result.foods).toHaveLength(0);
  });
});
