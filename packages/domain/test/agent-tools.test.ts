import { describe, expect, it } from 'vitest';

import {
  AGENT_TOOLS,
  NOT_REACHABLE_BY_AGENT,
  backedFunctions,
  toolsMissingCaution,
  unclassifiedFunctions,
} from '../src/agent-tools';

describe('el registro de herramientas', () => {
  it('LA REGLA: lo que no es rutina explica de qué hay que cuidarse', () => {
    // Un `sensitive` sin `caution` es una herramienta peligrosa sin su aviso, y
    // el aviso es lo único que separa "describe" de "recomienda".
    expect(toolsMissingCaution()).toEqual([]);
  });

  it('ninguna herramienta se declara `forbidden`: eso va en la lista de exclusión', () => {
    // `forbidden` existe en el tipo para el día que una herramienta se retire
    // sin borrarla. Hoy no debería haber ninguna: lo prohibido no se registra
    // como herramienta, se excluye con su motivo.
    expect(AGENT_TOOLS.filter((tool) => tool.risk === 'forbidden')).toEqual([]);
  });

  it('los nombres son únicos: uno repetido haría ambiguo qué se ejecutó', () => {
    const names = AGENT_TOOLS.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('cada función respaldada aparece una sola vez', () => {
    const backed = backedFunctions();
    expect(new Set(backed).size).toBe(backed.length);
  });

  it('una función no puede estar registrada Y excluida a la vez', () => {
    const both = backedFunctions().filter((name) => name in NOT_REACHABLE_BY_AGENT);
    expect(both).toEqual([]);
  });

  it('SEGURIDAD: escribir el perfil de terapia está excluido, con su motivo', () => {
    // `AGENTS.md`: los parámetros de terapia son valores que ingresa la usuaria.
    expect(backedFunctions()).not.toContain('saveTherapyProfile');
    expect(NOT_REACHABLE_BY_AGENT['saveTherapyProfile']).toMatch(/PROHIBIDO/u);
  });

  it('SEGURIDAD: no se puede borrar una lectura real de sensor', () => {
    expect(backedFunctions()).not.toContain('deleteCGMReading');
    expect(NOT_REACHABLE_BY_AGENT['deleteCGMReading']).toBeTruthy();
  });

  it('SEGURIDAD: una dosis suelta no es alcanzable — se registra la entrada entera', () => {
    // Escribir insulina sin su `entry_group_id` es el bug insulina↔comida.
    for (const suelta of ['saveInsulinEvent', 'updateInsulinEvent', 'deleteInsulinEvent']) {
      expect(backedFunctions()).not.toContain(suelta);
      expect(NOT_REACHABLE_BY_AGENT[suelta]).toBeTruthy();
    }
    expect(backedFunctions()).toContain('saveUnifiedEntry');
  });

  it('ningún motivo de exclusión está vacío o es de relleno', () => {
    for (const [name, reason] of Object.entries(NOT_REACHABLE_BY_AGENT)) {
      expect(reason.trim().length, `${name} sin motivo`).toBeGreaterThan(20);
      expect(reason.toLowerCase(), `${name} con motivo de relleno`).not.toMatch(/^(no aplica|n\/a|tbd|pendiente)/u);
    }
  });

  it('el agente llega al Modal Maestro entero, que es la promesa', () => {
    // Si `registrar_entrada` no estuviera, el agente sería más pobre que el
    // formulario — exactamente lo que `projectbrief.md` prohíbe.
    const names = AGENT_TOOLS.map((tool) => tool.name);
    expect(names).toContain('registrar_entrada');
    expect(names).toContain('editar_entrada');
    expect(names).toContain('borrar_entrada');
  });
});

describe('detectar lo que quedó sin clasificar', () => {
  it('una función nueva de db.ts sale como no clasificada', () => {
    expect(unclassifiedFunctions(['getTimeline', 'saveAlgoNuevo'])).toEqual(['saveAlgoNuevo']);
  });

  it('lo registrado y lo excluido no aparecen', () => {
    expect(unclassifiedFunctions(['getTimeline', 'saveTherapyProfile'])).toEqual([]);
  });

  it('sin funciones, no hay nada que reportar', () => {
    expect(unclassifiedFunctions([])).toEqual([]);
  });
});
