# ADR 0003: Catálogo de alimentos compartido — el backend gana estado, a propósito y acotado

Status: accepted (2026-08-21)

## Contexto

ADR 0001 fija el backend como sin estado: un proxy hacia CGM y Abacus
RouteLLM, sin persistencia de datos de usuaria. Ese diseño se mantiene.

Cada usuaria ya acumula, en su propio teléfono, un catálogo local de
alimentos identificados por IA, normalizado por 100 g
(`packages/domain/src/food-catalog.ts`, Fase 15/18). Compartir ese
conocimiento entre usuarias — para que una instalación nueva reciba buenas
estimaciones de alimentos comunes desde el primer día, sin gastar una foto
ni una llamada a Abacus por cada plato de arroz — requiere que alguien
central lo guarde. Investigado el 2026-08-20 (ver
`docs/DEEPAGENT_REDEPLOY_PROMPT.md`): el "Feature Store" de Abacus no sirve
(es analítico, no transaccional); las instancias de app de DeepAgent traen
su propio Postgres persistente, que es donde ya vive este backend.

## Decisión

El backend gana **un** estado: una tabla `food_catalog`, y **solo esa**.
No es un cambio de arquitectura general — es una excepción acotada y
documentada al ADR 0001, no su reversión.

La tabla es **anónima por construcción, no por promesa**: no existe columna
de id de usuaria, foto, glucosa, insulina, ni marca de tiempo de una comida.
`SharedCatalogEntryInputSchema` (`packages/schemas`) no declara esos campos,
así que no hay forma estructural de que un cliente los mande, ni de que el
servidor los guarde por accidente — el mismo principio de frontera
estructural que `MealSnapshotSchema` (Fase 17) usa para insulina.

Reusa las funciones puras que ya gobiernan el catálogo local
(`foodKey`, `isPlausibleCatalogEntry`, `blendCatalogEntry`, todas en
`packages/domain`), así que "cómo se agrupa un alimento" y "cómo se funde
una estimación nueva con la vieja" es **una sola implementación**, probada
una vez, usada en el teléfono y en el servidor.

Endpoints (`apps/api/src/app.ts`, `apps/api/src/food-catalog-store.ts`):

- `GET /v1/food-catalog?q=&limit=` — solo alimentos con
  `times_seen >= SHARED_CATALOG_MIN_TIMES_SEEN` (default 3): un alimento
  visto una vez sigue acumulándose, pero no se sirve a nadie todavía. Es el
  piso de moderación que el catálogo compartido necesita y el local no —
  una escritura mala en un teléfono solo afecta a esa usuaria; acá se
  propagaría a todas.
- `POST /v1/food-catalog` — sube entradas ya normalizadas por 100 g.
  Rechaza (sin tumbar el resto del lote) cualquier entrada implausible.
  Límite de cuerpo y de tasa propios, más chicos que el resto del backend:
  es la primera ruta de escritura anónima que existe acá.

El esquema se **auto-provee** al levantar el proceso
(`CREATE TABLE IF NOT EXISTS`, mismo patrón que ya usa
`apps/mobile/src/db.ts` con SQLite) — no requiere una migración manual ni
que quien despliegue entienda el schema.

`DATABASE_URL` ausente → los dos endpoints responden 503 y el resto del
backend sigue funcionando exactamente igual: la misma degradación "sin
configurar" que ya usa cada integración externa de `apps/api/src/config.ts`.

## Consecuencias

- El backend deja de ser 100 % sin estado. Cualquier corrida futura que
  toque `apps/api` tiene que saber que existe esta excepción y por qué.
- Un catálogo compartido acepta escrituras de cualquier instalación; el
  piso de `times_seen` y la fusión ponderada limitan el daño de una
  estimación mala, pero no lo eliminan. Si en el futuro se ve abuso, la
  respuesta es un piso más alto o una revisión manual, no volver a ADR 0001.
- La app móvil **todavía no llama a estos endpoints** (backend preparado,
  no consumido — ver `docs/ROADMAP_V0.2.md`). Cuando esa fase llegue, es
  trabajo puro de `apps/mobile`: el contrato de red ya existe y ya está
  desplegado.
