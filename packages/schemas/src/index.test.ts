import { describe, expect, it } from 'vitest';

import { AgentTurnSchema } from './index';

describe('AgentTurnSchema — el campo `opens`', () => {
  const base = { say: 'Algo.', draft: null, question: null, cites: [] };

  it('no hay dónde escribir una dosis: es un enum de tres valores', () => {
    // La razón por la que se le puede dejar ESTA decisión al modelo. Es la
    // Regla 2: si un dato no debe salir, el tipo no tiene dónde ponerlo.
    expect(AgentTurnSchema.safeParse({ ...base, kind: 'refusal', opens: '6 U' }).success).toBe(false);
    expect(AgentTurnSchema.safeParse({ ...base, kind: 'refusal', opens: 6 }).success).toBe(false);
    expect(AgentTurnSchema.safeParse({ ...base, kind: 'refusal', opens: 'bolus' }).success).toBe(false);
  });

  it('abrir una calculadora obliga a que el turno sea un rechazo', () => {
    // Si respondiera la pregunta Y abriera la calculadora, la frase del modelo
    // y el número de la app competirían — y la frase la escribió un modelo.
    expect(AgentTurnSchema.safeParse({ ...base, kind: 'answer', opens: 'correction' }).success).toBe(false);
    expect(AgentTurnSchema.safeParse({ ...base, kind: 'clarify', question: '¿Cuánto?', opens: 'meal' }).success).toBe(false);
    expect(AgentTurnSchema.safeParse({ ...base, kind: 'refusal', opens: 'correction' }).success).toBe(true);
  });

  it('un turno normal no abre nada', () => {
    expect(AgentTurnSchema.safeParse({ ...base, kind: 'answer', opens: null }).success).toBe(true);
  });
});
