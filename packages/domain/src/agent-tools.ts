/**
 * El registro de lo que el agente puede alcanzar — y de lo que no, con su razón.
 *
 * ## Por qué es código y no un documento
 *
 * `reference/ai-chat-capabilities.md` intentó ser el catálogo completo en prosa
 * y llegó a 123 de sus 150 líneas de techo. Un catálogo que crece con cada
 * corrida y vive en un archivo con tope termina "resumido" por alguien que borra
 * justo lo que importaba. Acá no hay techo, hay tipos, y `pnpm verify` falla si
 * una función nueva de `db.ts` no aparece.
 *
 * El documento se queda con **el porqué** —las cinco capacidades peligrosas, la
 * frontera, la lista de rechazos—, que es lo que un humano necesita leer y una
 * tabla no explica.
 *
 * ## La regla que sostiene todo
 *
 * **Toda función exportada de `db.ts` está en `AGENT_TOOLS` o en
 * `NOT_REACHABLE_BY_AGENT`, con su motivo escrito.** No hay tercera opción, y no
 * hay default: agregar una capacidad a la app sin decidir si el agente la
 * alcanza rompe el build. Es el mismo mecanismo que ya usa `verify:contracts`
 * cuando un activo apunta a un documento que no existe.
 */

/**
 * Cuánto cuidado exige una herramienta.
 *
 * - `routine`: si sale mal, se corrige y ya.
 * - `sensitive`: puede producir una lectura clínica equivocada, o escribir algo
 *   que la usuaria no dijo. **Exige `caution` y confirmación explícita.**
 * - `forbidden`: existe en la app, y el agente **no** la alcanza. Se declara
 *   para que nadie la "descubra" y la conecte sin leer por qué no estaba.
 */
export type AgentToolRisk = 'routine' | 'sensitive' | 'forbidden';

export interface AgentToolSpec {
  /** Cómo lo nombra el modelo. Estable: sale en prompts guardados. */
  name: string;
  /** La función real que lo ejecuta. El candado de `verify` compara contra esto. */
  backing: string;
  kind: 'read' | 'write';
  risk: AgentToolRisk;
  /** Qué hace, en una frase. Va al prompt tal cual. */
  summary: string;
  /** Por qué hay que tener cuidado. Obligatorio salvo en `routine`. */
  caution?: string;
}

/**
 * Lo que el agente puede hacer.
 *
 * Escribir **siempre** pasa por una confirmación de la usuaria; el modelo
 * propone un borrador y la app lo valida antes de mostrarlo. Ninguna herramienta
 * de escritura se ejecuta por decisión del modelo.
 */
export const AGENT_TOOLS: readonly AgentToolSpec[] = [
  // ── Lectura ──────────────────────────────────────────────────────────────
  {
    name: 'leer_timeline',
    backing: 'getTimeline',
    kind: 'read',
    risk: 'routine',
    summary: 'Los últimos registros, ya agrupados como los ve la usuaria.',
  },
  {
    name: 'leer_glucosa',
    backing: 'getCGMReadings',
    kind: 'read',
    risk: 'sensitive',
    summary: 'Lecturas de glucosa de un rango.',
    caution:
      'Cada lectura lleva su `origin` y su `sourceTimestamp`: una manual, una '
      + 'importada o una atrasada NUNCA se presenta como sensor en vivo. Y sin '
      + 'mirar el `DecodeTally`, "no tienes lecturas" puede ser falso.',
  },
  {
    name: 'leer_insulina',
    backing: 'getInsulinEvents',
    kind: 'read',
    risk: 'sensitive',
    summary: 'Dosis registradas en un rango, con su desglose si lo tienen.',
    caution:
      'Se puede decir qué se inyectó y cuándo. NO se puede estimar cuánta sigue '
      + 'actuando, ni afirmar que dos dosis se solaparon: eso es estimar IOB.',
  },
  {
    name: 'leer_insulina_reciente',
    backing: 'getRecentRapidInsulin',
    kind: 'read',
    risk: 'sensitive',
    summary: 'Dosis rápidas recientes, para contexto.',
    caution:
      'Con `unreadable > 0` en el `DecodeTally`, "no tienes insulina reciente" '
      + 'es falso justo donde más importa. Nunca afirmar completitud sin mirarlo.',
  },
  {
    name: 'leer_comidas',
    backing: 'getMealEvents',
    kind: 'read',
    risk: 'sensitive',
    summary: 'Comidas de un rango, con sus macros.',
    caution:
      '`macrosSource` ausente significa procedencia DESCONOCIDA, nunca '
      + '"confirmado por ella". Estimado por IA y confirmado no son lo mismo.',
  },
  { name: 'leer_carbohidratos', backing: 'getCarbEvents', kind: 'read', risk: 'routine', summary: 'Carbohidratos registrados en un rango.' },
  { name: 'leer_agua', backing: 'getWaterEvents', kind: 'read', risk: 'routine', summary: 'Agua bebida en un rango.' },
  { name: 'leer_actividad', backing: 'getActivityEvents', kind: 'read', risk: 'routine', summary: 'Actividad física registrada.' },
  { name: 'leer_notas', backing: 'getNoteEvents', kind: 'read', risk: 'routine', summary: 'Notas escritas por la usuaria.' },
  {
    name: 'leer_vitales',
    backing: 'getVitalsEvents',
    kind: 'read',
    risk: 'sensitive',
    summary: 'Peso, presión y cetonas.',
    caution:
      'Las cetonas se pueden nombrar por su banda y se puede decir que '
      + 'corresponde contactar al equipo clínico. NUNCA qué hacer con insulina, '
      + 'ni si suspender una dosis.',
  },
  {
    name: 'leer_hba1c',
    backing: 'getHbA1cResults',
    kind: 'read',
    risk: 'sensitive',
    summary: 'HbA1c de laboratorio que la usuaria anotó.',
    caution:
      'Es una medición real. La que calcula la app es una ESTIMACIÓN (GMI) y se '
      + 'rotula así; las dos nunca van juntas sin distinguirlas.',
  },
  { name: 'leer_recetas', backing: 'getRecipes', kind: 'read', risk: 'routine', summary: 'Recetas guardadas y sus componentes.' },
  {
    name: 'leer_catalogo',
    backing: 'getCatalogFoods',
    kind: 'read',
    risk: 'sensitive',
    summary: 'El catálogo de alimentos de la usuaria.',
    caution:
      'Son estimaciones de IA y lo siguen siendo al salir del catálogo: los '
      + 'carbohidratos se SUGIEREN, jamás se guardan como confirmados.',
  },
  {
    name: 'leer_perfil_terapia',
    backing: 'getTherapyProfile',
    kind: 'read',
    risk: 'sensitive',
    summary: 'Objetivo, factor de corrección, ratio e insulinas elegidas.',
    caution:
      'Solo mostrar. Nunca proponer un valor nuevo ni derivarlo de los datos: '
      + 'son valores que ingresa la usuaria. Si la fila existe y no decodifica, '
      + 'la función LANZA — no atrapar el error y seguir con un default.',
  },
  { name: 'leer_perfil_nutricion', backing: 'getNutritionProfile', kind: 'read', risk: 'routine', summary: 'Metas de energía y macros.' },
  { name: 'saber_si_hay_terapia', backing: 'isTherapyConfigured', kind: 'read', risk: 'routine', summary: 'Si la usuaria ya cargó sus parámetros.' },
  { name: 'leer_alarmas', backing: 'getMealAlarmOffsets', kind: 'read', risk: 'routine', summary: 'Los minutos de las alarmas post-comida.' },
  { name: 'leer_recordatorio_correccion', backing: 'getCorrectionReminderSettings', kind: 'read', risk: 'routine', summary: 'Recordatorio tras una corrección.' },
  { name: 'leer_recordatorio_capilar', backing: 'getCapillaryReminderSettings', kind: 'read', risk: 'routine', summary: 'Recordatorios de control capilar.' },
  { name: 'leer_estilo_alerta', backing: 'getReminderAlertStyle', kind: 'read', risk: 'routine', summary: 'Si los recordatorios suenan, vibran o son silenciosos.' },

  // ── Escritura ────────────────────────────────────────────────────────────
  {
    name: 'registrar_entrada',
    backing: 'saveUnifiedEntry',
    kind: 'write',
    risk: 'sensitive',
    summary: 'Registra una entrada completa: comida, carbohidratos, dosis, glucosa, agua, vitales y nota, todo junto.',
    caution:
      'Es el mismo payload del Modal Maestro, y por eso el agente no puede ser '
      + 'más pobre que él. Las unidades de insulina son SIEMPRE lo que ella '
      + 'tecleó o confirmó, nunca un número que el modelo propuso.',
  },
  {
    name: 'editar_entrada',
    backing: 'updateUnifiedEntryGroup',
    kind: 'write',
    risk: 'sensitive',
    summary: 'Edita una entrada ya guardada.',
    caution:
      'Un ancla de sensor se preserva y su valor no se reescribe. Un campo '
      + 'ausente NO es un cero: es "no tocar".',
  },
  {
    name: 'borrar_entrada',
    backing: 'deleteUnifiedEntryGroup',
    kind: 'write',
    risk: 'sensitive',
    summary: 'Borra una entrada completa.',
    caution: 'Nunca borra una lectura real de sensor. Exige confirmación explícita, siempre.',
  },
  { name: 'registrar_agua', backing: 'saveWaterEvent', kind: 'write', risk: 'routine', summary: 'Anota agua bebida. Solo agua: un jugo es comida.' },
  { name: 'registrar_nota', backing: 'saveNoteEvent', kind: 'write', risk: 'routine', summary: 'Guarda una nota.' },
  { name: 'registrar_actividad', backing: 'saveActivityEvent', kind: 'write', risk: 'routine', summary: 'Anota actividad física.' },
  {
    name: 'registrar_vitales',
    backing: 'saveVitalsEvent',
    kind: 'write',
    risk: 'sensitive',
    summary: 'Anota peso, presión o cetonas.',
    caution: 'Un blanco no es un cero: los campos ausentes se dejan como están.',
  },
  { name: 'guardar_alarmas', backing: 'saveMealAlarmOffsets', kind: 'write', risk: 'routine', summary: 'Cambia los minutos de las alarmas post-comida.' },
  { name: 'guardar_recordatorio_correccion', backing: 'saveCorrectionReminderSettings', kind: 'write', risk: 'routine', summary: 'Configura el recordatorio tras corregir.' },
  { name: 'guardar_recordatorio_capilar', backing: 'saveCapillaryReminderSettings', kind: 'write', risk: 'routine', summary: 'Configura los controles capilares.' },
  {
    name: 'guardar_perfil_nutricion',
    backing: 'saveNutritionProfile',
    kind: 'write',
    risk: 'sensitive',
    summary: 'Guarda las metas de energía y macros.',
    caution:
      'Separado del perfil de terapia A PROPÓSITO: cambiar una meta de peso no '
      + 'puede tocar nada que llegue a una jeringa.',
  },
  { name: 'corregir_alimento', backing: 'updateCatalogFood', kind: 'write', risk: 'sensitive', summary: 'Corrige un alimento del catálogo.', caution: 'Un valor imposible por 100 g sugiere carbohidratos imposibles en CADA comida futura que reuse ese alimento.' },
  { name: 'crear_variante_alimento', backing: 'createCatalogFoodVariant', kind: 'write', risk: 'routine', summary: 'Crea una variante de un alimento.' },
];

/**
 * Lo que el agente **no** alcanza, y por qué.
 *
 * Que algo esté acá no es un olvido: es una decisión escrita. Conectar
 * cualquiera de estas exige leer su motivo primero y, si sigue en pie, un ADR.
 */
export const NOT_REACHABLE_BY_AGENT: Readonly<Record<string, string>> = {
  // Plomería: no son capacidades, son cómo funciona la base.
  initializeDatabase: 'Abre y migra la base. No es una capacidad de producto.',
  serializedTransaction: 'Primitiva de transacciones. La usan las herramientas, no el agente.',
  migrateCachedPhotos: 'Migración interna de una sola vez, al abrir la app.',
  isFutureTimestamp: 'Guarda pura, sin efecto.',
  resolveLegacyBackendSensor: 'Resuelve si esta instalación puede usar la cuenta global del backend. Tocarla desde el chat podría hacer que un teléfono muestre el sensor de otra persona.',
  getSetting: 'Acceso crudo a ajustes por clave. El agente usa las herramientas con nombre, que sí declaran qué tocan.',
  setSetting: 'Escritura cruda de cualquier ajuste, incluidos los que gobiernan el sensor. Demasiado ancha para un modelo.',

  // Escrituras que la app hace por su cuenta, no a pedido de nadie.
  upsertCGMReadings: 'Las escribe la sincronización del sensor. Un modelo no inventa lecturas de glucosa.',
  deleteSensorReadings: 'Solo al desconectar una cuenta de sensor, desde Ajustes.',
  deleteCGMReading: 'Borrar una lectura real de sensor está prohibido por AGENTS.md.',
  updateManualCGMReading: 'Editar una glucosa puntual va por `editar_entrada`, que preserva el ancla del sensor.',
  recordCatalogFoods: 'Alta automática al confirmar una comida. El camino con confirmación es `registrar_entrada`.',
  saveImportedMealEvent: 'Solo para importaciones, que marcan su origen. El agente registra con `registrar_entrada`.',
  importMySugrCsv: 'Importar un archivo es un acto explícito de la usuaria en Ajustes, con su resumen antes de aplicar.',
  attachEntryToReading: 'Lo usa el flujo de la app al colgar una entrada de una lectura existente.',
  promoteEventToEntryGroup: 'Paso interno de la edición retroactiva; `editar_entrada` ya lo cubre.',

  // Episodios: los mide la app, no se editan a mano.
  updateEpisode: 'Un episodio lo mide la app con las lecturas reales. Editarlo a mano falsearía el análisis post-comida.',
  confirmEpisodeInsulinContext: 'Confirmación de contexto que vive en su propia pantalla.',
  deleteMealEpisode: 'Se borra con su comida, en cascada.',
  getCollectingEpisodes: 'Consulta interna del ciclo de medición.',
  getPendingInsulinAssociations: 'Consulta interna de la pantalla de asociación.',
  getEventsDuringEpisode: 'Alimenta `MealEpisodeMetrics`, que el agente sí lee ya resuelto.',
  getInsulinEventsForMeal: 'Consulta interna del episodio.',

  // Piezas sueltas de una entrada: el agente trabaja con la entrada entera.
  saveCarbEvent: 'Suelto rompería el empaquetado por `entry_group_id`. Va dentro de `registrar_entrada`.',
  updateCarbEvent: 'Editar los gramos sueltos desincroniza la comida de su espejo de carbohidratos, que ya se contaron dos veces una vez. Va por `editar_entrada`.',
  deleteCarbEvent: 'Borrar la fila espejo deja la comida sin sus carbohidratos, o al revés. El grupo se borra entero o no se borra.',
  saveInsulinEvent: 'Una dosis suelta sin su grupo es el bug de insulina↔comida otra vez.',
  updateInsulinEvent: 'Escribió `insulinName` incondicionalmente y cada guardado del grupo lo borraba: es un camino con historial de corromper el registro. Va por `editar_entrada`.',
  deleteInsulinEvent: 'Borrar una dosis sin su grupo deja la comida afirmando una cobertura que ya no existe.',
  saveMealWithEpisode: 'Escribe comida y episodio; `registrar_entrada` es el camino con confirmación.',
  deleteMealEvent: 'Se borra el grupo, no la comida sola.',
  updateMealFromEdit: 'Lo consume el editor de comida con IA, que ya muestra antes/después campo por campo.',
  updateNoteEvent: 'Va por `editar_entrada`.',
  deleteNoteEvent: 'Va por `borrar_entrada`.',
  updateWaterEvent: 'Va por `editar_entrada`.',
  deleteWaterEvent: 'Va por `borrar_entrada`.',
  deleteVitalsEvent: 'Va por `borrar_entrada`.',
  saveHbA1cResult: 'Un resultado de laboratorio lo transcribe la usuaria, no un modelo.',

  // Terapia: la frontera dura.
  saveTherapyProfile: 'PROHIBIDO. Los parámetros de terapia son valores que ingresa la usuaria; escribirlos desde el chat es inferirlos.',
  clearNutritionProfile: 'Borrado total de las metas. Va en Ajustes, con su confirmación.',

  // Catálogo y recetas: bordes con daño en cascada.
  deleteCatalogFood: 'Borrar un alimento puede dejar recetas incompletas. Tiene su propio flujo con resolución.',
  resolveRecipesAndDeleteFood: 'Ese flujo de resolución. Exige decisiones que la usuaria toma viendo las recetas afectadas.',
  setCatalogFoodListed: 'Ocultar un alimento sin que ella lo vea lo vuelve invisible sin explicación.',
  saveRecipe: 'Crear una receta pasa por su pantalla, que muestra los componentes y sus totales derivados.',
  updateRecipe: 'Renombrar cambia la clave normalizada con la que se evitan duplicados, así que puede partir en dos una receta que era una.',
  updateRecipeItems: 'Cambiar los componentes cambia en silencio los macros de toda comida futura que reuse la receta. Exige verlos.',
  updateRecipePhoto: 'La foto del plato es de la receta y la de cada componente es aparte; confundirlas fue un bug real.',
  deleteRecipe: 'Borrar una receta puede llevarse componentes privados que ninguna otra usa. Su pantalla muestra qué se pierde.',
  saveReminderAlertStyle: 'Cambia cómo suena una alarma en Android; el canal se congela al crearse y hay que manejar ids nuevos.',
};

/** Toda función que el agente alcanza, por su nombre real en `db.ts`. */
export function backedFunctions(): string[] {
  return AGENT_TOOLS.map((tool) => tool.backing);
}

/**
 * Qué funciones de `db.ts` no están clasificadas.
 *
 * Es lo que `verify:contracts` convierte en un build roto. Se exporta pura para
 * poder probarla sin leer archivos.
 */
export function unclassifiedFunctions(exported: readonly string[]): string[] {
  const known = new Set([...backedFunctions(), ...Object.keys(NOT_REACHABLE_BY_AGENT)]);
  return exported.filter((name) => !known.has(name)).sort();
}

/** Herramientas cuyo `caution` falta pese a no ser rutina. */
export function toolsMissingCaution(): string[] {
  return AGENT_TOOLS
    .filter((tool) => tool.risk !== 'routine' && (tool.caution ?? '').trim().length === 0)
    .map((tool) => tool.name);
}
