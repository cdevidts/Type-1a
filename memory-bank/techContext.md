# Tech Context — stack inmutable, prohibiciones y validación

## Stack (no se cambia sin decisión explícita de Verónica)

**Monorepo pnpm.** `pnpm@11.16.0`, `pnpm-workspace.yaml` → `apps/*` + `packages/*`.
Node **>=24**. TypeScript **~6.0.3**.

| Workspace | Paquete | Qué es |
|---|---|---|
| `apps/mobile` | `@type1a/mobile` | Expo SDK **~57.0.12**, React Native **0.86.2**, React **19.2.3** |
| `apps/api` | `@type1a/api` | **Fastify 5.7.4** + cors + rate-limit, ejecutado con `tsx` |
| `packages/schemas` | `@type1a/schemas` | **Zod 4.4.3** — el contrato entre todo |
| `packages/domain` | `@type1a/domain` | Lógica determinística. **Sin red, sin IA** |
| `packages/cgm` | `@type1a/cgm` | Interfaz `CGMProvider` + implementaciones |
| `packages/ai` | `@type1a/ai` | Cliente Abacus RouteLLM. **Solo backend** |

**Persistencia:** `expo-sqlite` (12 tablas, dispositivo, fuente de verdad) +
PostgreSQL vía `pg` (`Pool`) solo para el catálogo compartido.

**Otras dependencias que importan:** `react-native-svg` 15.15.4 (todos los
gráficos), `lucide-react-native` (iconos), `xlsx` (export Excel),
`expo-notifications`, `expo-secure-store`, `date-fns-tz`.

### Configuración TypeScript crítica (`tsconfig.base.json`)

`strict`, `verbatimModuleSyntax`, `isolatedModules`, `moduleResolution: "Bundler"`, y dos que muerden a diario:

- **`exactOptionalPropertyTypes: true`** — `{ x: undefined }` NO es lo mismo que
  `{}`. Para *omitir*, omite la clave. Para *borrar* un valor existente en un
  spread, hay que escribir `undefined` explícitamente (y el tipo debe incluirlo).
- **`noUncheckedIndexedAccess: true`** — todo acceso por índice es `T | undefined`.

## Prohibiciones arquitectónicas

### NINGUNA librería de gestión de estado

Sin Redux, Zustand, Jotai, MobX, Recoil ni TanStack Query. El estado vive en
`App.tsx` (~1.480 líneas) con `useState`/`useCallback`/`useMemo`, y baja a los
componentes por props. `App.tsx` es el store de facto.

**No agregues una.** Si un estado se vuelve difícil de pasar, la respuesta es
Context o subir el cálculo a `packages/domain`, no una dependencia nueva.

### NINGUNA librería de navegación

Sin react-navigation ni expo-router. Una pantalla es un `<Modal>` a través de
**`ModalShell`**. La navegación lateral entre destinos es un gesto propio:
`swipeGuard.ts` (árbitro contra el scroll horizontal de los gráficos),
`swipeOrder.ts` (recorrido, con test) y `useSwipeNavigation.ts`.

Si hacen falta sub-páginas, se usa una barra de pestañas **dentro** del modal
(ver `SummaryModal.tsx`), no una dependencia nueva.

### Ninguna librería de gráficos

`react-native-svg` en la app, SVG inline en el PDF (`reportExport.ts`).

## Comandos de validación obligatorios

```bash
pnpm verify   # lint + typecheck + test en los 6 workspaces, y AHORA el bundle
```

Se expande a:

```bash
pnpm lint         # eslint 9 + typescript-eslint 8 (flat config)
pnpm typecheck    # tsc --noEmit
pnpm test         # vitest run
pnpm verify:bundle
```

### `verify:bundle` — por qué existe y por qué no es opcional

```bash
cd apps/mobile && pnpm exec expo export --platform android --output-dir <tmp>
```

**`tsc` y `vitest` reescriben `.js` → `.ts` en imports relativos. Metro no.**
Eso rompió **dos builds** con `pnpm verify` en verde. Hasta el 2026-08-26 este
comando no estaba en `verify` y era el hueco de validación más grande del repo.

También funciona de canario de bundle: **línea base 1.333 módulos**. Un salto
grande delata un import de barrel.

> Nota sobre el flag: `-p` **es** el alias de `--platform`, y sus únicos
> valores válidos son `android|ios|web|all`. `-p none` no existe. La validación
> exporta a un directorio temporal que se borra al terminar.

### Trampas operativas que ya costaron tiempo real

- **Metro no hace tree-shaking de barrels.** Lucide se importa SIEMPRE por
  subpath: `lucide-react-native/icons/plus`. Medido: 1.263 → **3.088** módulos
  por barrel vs. 1.316 por subpath.
- **`\b` en regex de JavaScript es ASCII.** `qu[eé]\b` no matchea "qué". Usar
  `(?![a-záéíóúñ])`. Un guardrail de seguridad no disparaba por esto.
- **Android congela sonido/vibración de un canal de notificación al crearlo.**
  Cambiarlos exige un id de canal NUEVO, y borrar huérfanos con
  `deleteNotificationChannelAsync` — pero **nunca uno con algo programado
  encima**: Android descarta en silencio la notificación de un canal borrado.
- **`panHandlers` sobre un `ScrollView` nativo no dispara nunca.** Van en un
  `View` que lo envuelve, reclamando en fase de captura.
- **`eas-cli` se corre desde `apps/mobile/`, nunca desde la raíz** (deja
  `app.json`/`eas.json` scaffold basura). Perfiles: `preview` → `.apk`
  instalable; `production` → `.aab` **no instalable**.
- **`eas build:view <id> --json`** funciona; `--non-interactive` no existe en
  ese subcomando y falla en silencio.

## CI

`.github/workflows/verify.yml` — `pnpm install --frozen-lockfile && pnpm verify`
en cada push y PR (Node 24, pnpm 11.16.0).
`.github/workflows/backend-keepalive.yml` — ping cada 15 min a `/health`.

## Procedencia clínica de las constantes

Los números clínicos del dominio no son inventados. Fuentes consultadas:

- **Duración de insulinas** (`packages/domain/src/insulin-catalog.ts`):
  Cleveland Clinic, *Injectable insulin medications* — análogas rápidas
  (lispro/aspart/glulisina) 3-5 h; regular humana 5-8 h; NPH 14-24 h;
  detemir y glargina U-100 hasta 24 h; glargina U-300 hasta 36 h; degludec
  hasta 42 h. Fiasp/Lyumjev adelantan inicio y fin ~5-12 min pero **la
  duración total se queda en el mismo rango**.
- **Respuesta post-prandial con comidas solapadas**
  (`macro-glucose.ts`, `regression.ts`): el estándar iAUC **trunca** el tramo
  solapado, no descarta la comida (PubMed 31569815; AJCN/medRxiv "Imprecision
  nutrition"). Y ante un confusor **medido** se **ajusta por él**, no se
  elimina la observación (BMC Medicine 2025; PMC11715647). Descartar solo vale
  si la pérdida es aleatoria — acá no lo es.
- **Umbrales de glucosa** 54/70/180/250 mg/dL y HbA1c estimada por GMI
  (Bergenstal et al., Diabetes Care 2018).
- **Cetonas en sangre** 0,6 / 1,5 / 3,0 mmol/L.
