# Progress

_Última actualización: 2026-08-26._

## Estado de validación

| | |
|---|---|
| `pnpm verify` | ✅ verde |
| Tests | **372** — domain 266, mobile 68, ai 15, schemas 13, cgm 10, api 10 |
| Bundle de Metro | **1.333 módulos** (línea base; un salto grande = barrel importado) |
| CI | `.github/workflows/verify.yml` en cada push y PR |

## Entregado y en el dispositivo

Build `preview` (`.apk`) del 2026-08-26 instalado. Incluye:

- **Fase 19** — notificaciones distinguibles: emoji, color y título por tipo, y
  un canal de Android por tipo (interruptor propio en los ajustes del sistema).
  Más un botón "Probar cómo se ven" en Ajustes.
- **Fase 21** — "Comida" reemplaza a "Carbos" y "Rápida"; comida e insulina bajo
  un mismo timestamp; tres decisiones independientes (registrar / catálogo /
  insulina); macros al editar.
- **Fase 23** — el episodio captura todo lo de su ventana.
- **Catálogo de insulinas** con duración configurable (rápidas y basales), en
  Ajustes y en el flujo de primer uso.
- **Patrones y Comidas** rehechos: se ajusta por covariables en vez de excluir.
- **Cetonas** en "Nueva entrada", en el editor y en el timeline.
- Accesos rápidos rediseñados con iconos de Lucide (se fueron los glifos
  Unicode `ƒ(x)`, `mmol/L`, `◎`).

## Deuda conocida

### 🔴 Bomba: imports `.js` en `@type1a/ai`

`packages/ai/src/abacus.ts:23` y `packages/ai/src/index.ts:1-2` usan extensión
`.js` en imports relativos — **la trampa de Metro que rompió dos builds**.

Hoy **no explota solo porque `apps/mobile/package.json` no depende de
`@type1a/ai`**. `domain`, `cgm` y `schemas` (los que sí se bundlean) están
limpios.

El día que la app móvil dependa de `@type1a/ai` —el chat de IA es el candidato
obvio— el bundle rompe con `pnpm verify` en verde. Ahora `verify:bundle` lo
atraparía, pero **la causa sigue ahí**: la regla se aplica de forma
inconsistente entre paquetes. Arreglarlo cuesta tres líneas y elimina la mina.

### 🟠 Sin refactor: componentes de formulario compartidos

No existe `MacroFields` ni ningún componente compartido entre los cuatro
formularios de comida. `parseNonNegativeNumber` está replicado 37 veces.
Detalle y plan en `activeContext.md`.

### 🟠 Sin refactor: `resolveMacrosSource` en dominio

Cuatro implementaciones divergentes de la misma regla. Detalle en
`activeContext.md`.

### 🟡 Menores

- Cetonas del acceso rápido (sin grupo) invisibles en el timeline.
- Editar una entrada no ofrece foto ni re-análisis de IA.
- `README.md` eliminado en la migración a Memory Bank: el repo no tiene hoy una
  puerta de entrada para un humano nuevo en GitHub.

## Historial de fallos que definieron las reglas

Se conserva porque cada uno costó un build, una corrida o un número falso en un
reporte médico. El detalle completo vive en el historial de git
(`git log --format=full`), que quedó como la bitácora del proyecto.

| Fallo | Regla que produjo |
|---|---|
| `.js` en imports relativos rompió 2 builds con verify en verde | `verify:bundle` obligatorio |
| Barrel de Lucide: 1.263 → 3.088 módulos | subpath obligatorio, canario de bundle |
| Filas sueltas emparejadas por timestamp | `entry_group_id` (Regla 3b) |
| `macrosSource` en 4 capas → 3 bugs | Regla 1 |
| Prompt con dosis habilitó afirmar IOB sin disparar el filtro | Regla 2 hermana |
| Promedio "ajustado" publicaba +57 donde la verdad era +10, con 372 tests en verde | test contra verdad sembrada |
| Exclusión binaria vació la pantalla de Patrones | truncar y ajustar, nunca obviar |
| `.positive()` en un esquema rompió un caso legítimo una corrida después | Regla 3, hermana |
| `eas-cli` desde la raíz dejó `app.json`/`eas.json` basura (2 veces) | correr desde `apps/mobile/` |

## Redeploy del backend

`apps/api` **no** se tocó desde el último despliegue salvo `packages/ai/src/prompts.ts`
(prompt del insight a `glucose-insight.v5`). El backend desplegado sigue con el
prompt anterior: es de bajo riesgo y **no urgente**. Cada redeploy consume
créditos de Abacus, así que se agrupa y no se dispara salvo que sea crítico.
