# Memory Bank — índice de ruteo

No leas esta carpeta entera "por si acaso". `CLAUDE.md` fija los cinco archivos
que se leen **siempre**; esta tabla dice cuándo vale la pena traer el resto.

## Capa 2 — se lee siempre (orden de `CLAUDE.md`)

| Archivo | Qué contiene | Cuándo es decisivo |
|---|---|---|
| `projectbrief.md` | qué es la app, qué no puede hacer nunca, quién la usa | siempre; es lo que hace que una decisión de producto no se invente |
| `techContext.md` | stack inmutable, prohibiciones, comandos, trampas medidas | antes de agregar una dependencia o dar un build por bueno |
| `systemPatterns.md` | las tres Reglas de Oro del código | antes de escribir lógica que ya existe en otra capa |
| `workflow.md` | commits, qué skill se dispara sola, auditoría de cierre | al abrir y al cerrar la corrida |
| `activeContext.md` | foco actual, qué se cerró, qué quedó abierto | siempre; es lo que cambia entre corridas |
| `progress.md` | validación, deuda, bugs vivos, historial fallo→regla | siempre; ahí están los bugs que todavía muerden |

## Capa 2 — bajo demanda

| Archivo | Cuándo traerlo |
|---|---|
| `codemap.md` | vas a tocar código y no sabes en qué archivo vive — es "vas a tocar X → lee Y" |
| `reference/ux-rationale.md` | vas a diseñar algo **sin patrón previo** en la app y necesitas el porqué tipográfico o de espaciado. Para revisar una pantalla basta `contracts/ux-checklist.md` |
| `reference/clinical-sources.md` | vas a cambiar una constante clínica (umbrales, duración de insulina, metas) y necesitas su respaldo |
| `reference/ai-chat-capabilities.md` | trabajas en el chat de IA o agregas una capacidad que el chat futuro debería alcanzar |
| `reference/catalog-recipes.md` | vas a tocar recetas del catálogo, duplicados propuestos por la IA, calorías en la tarjeta de alimento, fotos por alimento, o la nota que el botón rápido no guarda |

## Capa 1 — contratos (`/contracts/`)

Los declara `contracts/manifest.json` y los verifica `pnpm verify:contracts`.
Un skill los lee **enteros**; no hay versión resumida.

| Contrato | Lo consume |
|---|---|
| `ux-checklist.md` | `/ui-screen`, `/app-shell` |
| `safety-acceptance.md` | `domain-safety-reviewer`, `/safety-audit` |
| `cgm-provider.md` | `/new-cgm-provider` |
| `dataviz-palette.md` | `/ui-screen` (con la skill global `dataviz`) |

## Capa 3 — archivo (`docs/adr/`)

Append-only, nunca se purga. `docs/adr/README.md` es el índice; los ADR
completos se leen solo cuando hace falta el contexto de una decisión vieja.

## Historia anterior a esta estructura

El árbol previo a la migración —incluido `ROADMAP_V0.2.md` con sus 2.833
líneas de post-mortems— está en el commit **`af6c865`**, etiquetado
`archive/pre-memory-bank`:

```
git show af6c865 --stat          # qué había
git checkout af6c865 -- docs/    # traerlo de vuelta
```

**Usa el SHA, no el tag, si el tag no aparece.** `af6c865` es ancestro de la
rama principal, así que viaja con la historia y está en cualquier clon. El tag
es solo un alias cómodo, y el proxy git de los entornos remotos no relaya refs
de tags: puede existir localmente y no en el remoto.

Los cuerpos de commit son la bitácora real del proyecto (`git log --format=full`).
