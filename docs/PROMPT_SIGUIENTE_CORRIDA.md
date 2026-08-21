# Prompt para la corrida siguiente — Fase 18

Copiar y pegar **todo lo que está dentro del bloque**. Está escrito para que la
corrida no gaste tokens re-explorando: las decisiones ya están tomadas y los
archivos y constantes ya están localizados.

> **Hábito permanente (pedido de Verónica, 2026-08-20):** este archivo se
> reescribe **al cierre de cada corrida**, apuntando a la corrida siguiente.
> Es el punto 6 del checklist de `CLAUDE.md § Cierre de corrida`. Una corrida
> que termina sin dejar este prompt apuntando a lo próximo no está cerrada.

---

```
Fase 18 del roadmap: pantalla de catálogo de alimentos editable, porciones, y
la pregunta de tres salidas que evita corromper el catálogo. Todo es JS, no
toca nada nativo: se acumula con la Fase 17 en un solo build.

Lee primero docs/ROADMAP_V0.2.md § "Fase 18". No re-explores el repo: los
datos que necesitas están abajo. Invoca /ui-screen (tocas .tsx) y /app-shell
(el botón "Catálogo" de la barra inferior deja de ser inerte).

EL PROBLEMA: el catálogo se llena solo desde cada análisis de IA
(`recordCatalogFoods`, db.ts) y se reusa en MealModal, pero **no hay dónde
verlo ni corregirlo**. Si la IA guardó "arroz" con una estimación mala, queda
mala para siempre y contamina cada comida que lo reusa. `deleteCatalogFood`
ya existe en db.ts, sin ningún botón que la llame.

LO QUE YA ESTÁ HECHO Y SE REUSA (no lo reescribas):
- `CatalogFood` (packages/domain/src/food-catalog.ts): key, name,
  carbsPer100g, proteinPer100g, fatPer100g, fiberPer100g, kcalPer100g,
  timesSeen, lastSeenAt. Todo se guarda **por 100 g**.
- `scaleCatalogFood(food, grams)` — escala a una porción. Lanza si grams <= 0.
- `getCatalogFoods(db, limit)`, `recordCatalogFoods`, `deleteCatalogFood`.
- El modo de edición por IA de la Fase 17: `editMealWithInstruction` en
  apps/mobile/src/api.ts, tercera rama de `/v1/ai/meal-analysis`. La edición
  del catálogo por texto es el MISMO patrón — reúsalo, no inventes otro.

TRABAJO, en este orden:

1. PANTALLA DE CATÁLOGO. apps/mobile/src/components/CatalogModal.tsx (nuevo).
   Listar, buscar por nombre, editar a mano, editar con IA por texto, borrar.
   Cada alimento muestra `timesSeen`: un alimento visto 12 veces tiene una
   estimación más asentada que uno visto una vez, y eso cambia cuánta
   confianza merece. Estado vacío obligatorio ("todavía no hay alimentos;
   aparecen solos cuando la IA identifica una comida").
   Engánchala al botón "Catálogo" de BottomNav.tsx, que hoy solo muestra un
   aviso de "todavía no está".

2. PORCIÓN DE REFERENCIA. Hoy todo es por 100 g fijo. Agrega a `CatalogFood`
   un tamaño de porción de referencia editable (ej. "1 taza = 150 g"), sin
   romper las filas ya guardadas: el campo va OPCIONAL y, ausente, se asume
   100 g. Hay datos reales en el teléfono de Verónica — una migración que los
   invalide es inaceptable.

3. PORCIONES AL REUSAR. En MealModal.tsx, `applyCatalogFood` hoy pide gramos.
   Pasa a pedir **cuántas porciones, de 0,1 a 10**, y multiplica por el tamaño
   de referencia. Deja los gramos como alternativa visible: quien pesa en
   balanza no debería tener que dividir mentalmente.

4. LA PREGUNTA DE TRES SALIDAS. Es el corazón de la fase.
   El único campo editable sin tocar el catálogo es "cuántas porciones" — eso
   es un dato de ESA comida. Cualquier otro cambio (macros, nombre, tamaño de
   la porción de referencia) sobre una comida que vino del catálogo dispara,
   ANTES de guardar:
     1. Editar el alimento del catálogo — lo corrige para siempre.
     2. Crear uno nuevo — deja el original intacto y guarda una variante.
     3. No guardar en el catálogo — el cambio vale solo para esta comida.
   Sin esa pregunta, corregir una comida puntual corrompe en silencio el
   alimento que se reutiliza en todas las demás.

FRONTERA DE SEGURIDAD (AGENTS.md, no negociable):
- Un valor del catálogo es una media de estimaciones de IA, NO un dato pesado.
  Ya está resuelto en MealModal (`catalogSuggestedCarbsG` se guarda como
  `aiEstimatedCarbsG`); la pantalla nueva tiene que decirlo también.
- Los carbohidratos confirmados los sigue escribiendo la usuaria. El catálogo
  sugiere.
- La edición por IA del catálogo pasa por `requestsInsulinAdvice` igual que la
  de comidas.

CIERRE OBLIGATORIO (CLAUDE.md § Cierre de corrida):
- pnpm verify en verde.
- npx expo export:embed --eager --platform android --dev false desde
  apps/mobile, ANTES de gastar build. Metro NO reescribe .js→.ts en imports
  relativos: si escribes './algo.js' en un paquete, tsc y vitest pasan y el
  build muere. Ya pasó dos veces.
- Iconos: SIEMPRE por subpath, nunca desde el barrel. Metro no hace
  tree-shaking (medido: 1.263 → 3.088 módulos por el barrel; 1.320 hoy con
  ocho iconos por subpath). Archivo en kebab-case.
    import Plus from 'lucide-react-native/icons/plus';   // ✅
    import { Plus } from 'lucide-react-native';          // ❌
- domain-safety-reviewer si tocas packages/domain o packages/ai. OJO: el
  subagente puede fallar por límite de gasto de la cuenta; si pasa, corre
  /safety-audit tú mismo y dilo explícitamente, no lo saltes.
- docs/CODE_MAP.md: CatalogModal, el campo de porción de referencia.
- docs/AI_CHAT_ARCHITECTURE.md § 3: editar el catálogo es una capacidad W.
- docs/DEEPAGENT_REDEPLOY_PROMPT.md: la edición del catálogo por IA reusa la
  rama que YA existe en apps/api (no agrega ninguna), así que si no tocas
  apps/api, anótalo en la tabla de "no requirió redeploy". El redeploy de la
  Fase 17 sigue pendiente y sin disparar.
- docs/ROADMAP_V0.2.md: marca la Fase 18 completada.
- Reescribe docs/PROMPT_SIGUIENTE_CORRIDA.md apuntando a la Fase 19.
- Commit + push a claude/revision-build-prep-b6p20n.

Reporta los cambios y espera aprobación antes del build.
```

---

## Por qué la Fase 18 y no la 19

- **Es la última que no necesita build propio.** Las Fases 19 (notificaciones)
  y 20 (widget) tocan configuración nativa y cada una necesita el suyo; la 18
  se acumula con la 17 en un solo build.
- **La 17 la dejó a mitad de camino.** La edición por instrucción ya existe;
  aplicarla al catálogo es reusar el mismo endpoint.

## Estado de la ruta

| Fase | Alcance | ¿Build? | ¿Redeploy? |
|---|---|---|---|
| ~~16~~ | ~~Barra inferior, swipe, iconos, marcas de hora~~ | Hecho (`98acb218`) | No |
| ~~17~~ | ~~Editar comida con IA (foto, texto, instrucción)~~ | Hecho, sin build aún | **Sí, pendiente** |
| **18** | Catálogo editable, porciones, pregunta de 3 salidas | No (JS) | No (reusa la rama de la 17) |
| 19 | Notificaciones distinguibles | **Sí, propio** | No |
| 20 | Widget 4×3 de pantalla de inicio | **Sí, propio** | No |

**Decisión de la Fase 19 ya tomada** (está en el roadmap, no hay que
re-derivarla): se combinan las cuatro capas — emoji al inicio del título,
`content.color` por tipo, título explícito por tipo, y **un canal de Android
por tipo de alarma**. Lo que NO se hace: un icono pequeño distinto por tipo,
que exige un config plugin nativo propio y no lo justifica.
