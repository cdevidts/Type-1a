# Prompt para la corrida siguiente — Fase 17

Copiar y pegar **todo lo que está dentro del bloque**. Está escrito para que la
corrida no gaste tokens re-explorando: las decisiones ya están tomadas y los
archivos y constantes ya están localizados.

> **Hábito permanente (pedido de Verónica, 2026-08-20):** este archivo se
> reescribe **al cierre de cada corrida**, apuntando a la corrida siguiente.
> Es el punto 6 del checklist de `CLAUDE.md § Cierre de corrida`. Una corrida
> que termina sin dejar este prompt apuntando a lo próximo no está cerrada.

---

```
Fase 17 del roadmap: editar una comida con la misma potencia que crearla.
Todo el lado móvil es JS (no toca nada nativo), pero el modo nuevo de IA vive
en apps/api → NO alcanza con el build: necesita redeploy para funcionar.

Lee primero docs/ROADMAP_V0.2.md § "Fase 17". No re-explores el repo: los
datos que necesitas están abajo. Invoca /ui-screen (tocas .tsx) y el subagente
domain-safety-reviewer al cierre (tocas packages/ai y packages/domain).

EL PROBLEMA: hoy MealModal.tsx crea una comida con foto, texto o catálogo,
pero TimelineDetailModal.tsx en `item.kind === 'meal'` solo deja editar la
NOTA (App.tsx línea ~643 → updateMealNote). Si guardaste solo los carbos, no
hay forma de decir después "esto era un sándwich de queso" y completar macros.

TRABAJO, en este orden:

1. SCHEMAS (packages/schemas/src/index.ts). Agrega:
   - MealSnapshotSchema: lo que se le manda a la IA de la comida actual —
     note, confirmedCarbsG, proteinG, fatG, fiberG, caloriesKcal y los foods
     del análisis previo si existen.
     PROHIBIDO incluir insulina, glucosa o parámetros de terapia. La frontera
     se hace ESTRUCTURAL: si el campo no existe en el schema, no hay prompt
     que lo alcance.
   - MealEditInputSchema = { instruction: string (1..300), current:
     MealSnapshot }.
   La salida reusa MealAnalysisSchema/MealAnalysisResultSchema tal cual.

2. IA (packages/ai). prompts.ts: MEAL_EDIT_PROMPT_VERSION =
   'meal-analysis-edit.v1' + mealEditSystemPrompt. El prompt recibe la comida
   actual + la instrucción y devuelve la comida COMPLETA revisada (no un
   diff): un diff obliga a fusionar en el cliente y ahí se cuelan errores.
   abacus.ts: tercera variante de MealVisionInput. Mismo guardrail
   containsTherapyRecommendation sobre la salida.

3. GUARDRAIL DE ENTRADA (packages/domain/src/ai-safety.ts). Función nueva
   `requestsInsulinAdvice(instruction)`: si la usuaria escribe "cuánta
   insulina me pongo", se rechaza ANTES de gastar la llamada, con un mensaje
   que explique por qué. Hoy solo se filtra la salida; una instrucción así
   nunca debería llegar al modelo. Test obligatorio (AGENTS.md § Completion).

4. BACKEND (apps/api/src/app.ts). MealAnalysisBodySchema es un z.union —
   agrégale la tercera rama { instruction, current }. Mismo endpoint
   /v1/ai/meal-analysis, mismo manejo de errores.

5. MÓVIL. apps/mobile/src/api.ts: editMealWithInstruction(...).
   apps/mobile/src/db.ts: updateMealFromEdit(db, id, patch) que actualice
   macros + note + confirmedCarbsG. OJO: los carbos confirmados viven
   DUPLICADOS en carb_events (source 'meal_confirmed', pareado por
   timestamp) — reusa el propagador de updateMealCarbsAndNoteRows o los dos
   se bifurcan. Y aiEstimatedCarbsG/aiAnalysisId son el registro de lo que
   la IA dijo: se REEMPLAZAN cuando hay análisis nuevo, no se borran.

6. UI: apps/mobile/src/components/MealEditModal.tsx (nuevo). Tres caminos,
   los mismos que al crear más el propio de edición:
     a. Foto → re-analiza y reemplaza.
     b. Texto → estima desde descripción.
     c. "Explícale el cambio" → instrucción en lenguaje natural.
   CONFIRMACIÓN OBLIGATORIA: la IA propone, se muestra el antes/después
   campo por campo, y no se guarda nada hasta que ella toca Guardar.
   Engánchalo desde el branch `meal` de TimelineDetailModal.tsx (hoy solo
   muestra el campo de nota).

FRONTERA DE SEGURIDAD (AGENTS.md, no negociable):
- La IA propone macros; NUNCA insulina. Si la comida tiene dosis registrada,
  la edición no la toca — de hecho la dosis ni siquiera se envía.
- macrosSource pasa a 'ai' o 'mixed' según corresponda; nunca a 'user' por
  una edición de IA.
- Los carbos confirmados los sigue escribiendo ella. La IA los sugiere.

CIERRE OBLIGATORIO (CLAUDE.md § Cierre de corrida):
- pnpm verify en verde.
- npx expo export:embed --eager --platform android --dev false desde
  apps/mobile, ANTES de gastar build. Metro NO reescribe .js→.ts en imports
  relativos: si escribes './algo.js' en un paquete, tsc y vitest pasan y el
  build muere. Ya pasó dos veces.
- Iconos: SIEMPRE por subpath, nunca desde el barrel. Metro no hace
  tree-shaking (medido: 1.263 → 3.088 módulos por el barrel; 1.316 por
  subpath). Archivo en kebab-case.
    import Plus from 'lucide-react-native/icons/plus';   // ✅
    import { Plus } from 'lucide-react-native';          // ❌
- domain-safety-reviewer: OBLIGATORIO (tocas packages/ai y packages/domain).
- docs/CODE_MAP.md: MealEditModal, requestsInsulinAdvice, updateMealFromEdit.
- docs/AI_CHAT_ARCHITECTURE.md § 3: la edición por instrucción es
  exactamente el patrón que va a usar el chat. Anótala como W con su nota
  de seguridad.
- docs/DEEPAGENT_REDEPLOY_PROMPT.md: esta corrida SÍ toca apps/api →
  documenta el redeploy, NO lo dispares.
- docs/ROADMAP_V0.2.md: marca la Fase 17 completada.
- Reescribe docs/PROMPT_SIGUIENTE_CORRIDA.md apuntando a la Fase 18.
- Commit + push a claude/revision-build-prep-b6p20n.

NO hagas el build al final: reporta los cambios y espera aprobación.
```

---

## Por qué la Fase 17 y no la 18

- **La 18 depende de la 17.** El catálogo editable de la Fase 18 edita
  alimentos con IA por texto — es el mismo modo de instrucción que se
  construye acá. Hacer la 18 primero significaría escribirlo dos veces.
- **Es el bug de uso más frecuente que queda.** Una comida mal registrada hoy
  se borra y se rehace; no se corrige.

## Ruta sin build nuevo (contexto, no para pegar)

| Fase | Alcance | ¿Build? | ¿Redeploy? |
|---|---|---|---|
| ~~16~~ | ~~Barra inferior, swipe, iconos, marcas de hora~~ | Hecho (`98acb218`) | No |
| **17** | Editar con IA (foto, texto, "explícale el cambio") | No (JS) | **Sí** — modo nuevo en `/v1/ai/meal-analysis` |
| **18** | Catálogo editable, porciones, pregunta de 3 salidas | No (JS) | Solo la parte de editar catálogo con IA |

Las Fases 19 (notificaciones) y 20 (widget) tocan configuración nativa y
**cada una necesita su propio build**, así que quedan fuera de cualquier ruta
"sin build".
