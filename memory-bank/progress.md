# Progress

_Última actualización: 2026-08-26._

## Estado de validación

| | |
|---|---|
| `pnpm verify` | ✅ verde |
| Tests | **382** — domain 266, mobile 68, ai 15, schemas 13, cgm 10, api 10 |
| Bundle de Metro | **1.333 módulos** (línea base; un salto grande = barrel importado) |
| CI | `.github/workflows/verify.yml` en cada push y PR |

`pnpm verify` corre, en orden: `verify:contracts` (guard de memoria agéntica,
<1 s), `lint`, `typecheck`, `test`, `verify:bundle` (export real de Metro).

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

### 🔴 Seis hallazgos vivos que la revisión repuntada encontró (2026-08-26)

Salieron de correr el `domain-safety-reviewer` contra `d868ece` y `c4ca192`.
**Ninguno está arreglado.** Los dos primeros corrompen datos hoy.

1. **`macrosSource` se descarta en silencio al crear desde "Nueva entrada".**
   `App.tsx:saveEntry` lo esparce en la llamada, pero `UnifiedEntryInput`
   (`db.ts:713-745`) no tiene el campo y `writeMealWithEpisode` (`db.ts:821-834`)
   nunca lo lee. TypeScript no lo atrapa: el chequeo de propiedades en exceso
   **no aplica a un spread**. Consecuencia: los macros estimados por IA se
   guardan sin procedencia y el PDF del control médico dice "de procedencia no
   registrada" en vez de "estimada(s) por IA sin corregir".
2. **Una entrada solo de macros se descarta y dice "Entrada guardada".**
   `hasMeal` de `saveUnifiedEntry` (`db.ts:788`) sigue mirando solo
   carbos/descripción/imagen. El de `updateUnifiedEntryGroup` (`db.ts:926`) sí
   incluye macros: se arregló el camino de edición y no el de creación.
3. **La basal es invisible al modelo y al aviso de ventana sucia.**
   `macro-glucose.ts:281-287` no tiene rama para `basal_insulin`, así que 20 U
   de Tresiba en la ventana no entran como covariable **ni** marcan
   `confoundedCount`. La pantalla imprime "sin eventos".
4. **Cantidad ausente = "no pasó nada".** `event.amount ?? 0` con
   `any = ... > 0`: una comida real sin carbos confirmados desaparece del conteo.
5. **Un fallo al registrar la insulina se pisa con un mensaje de éxito.**
   `App.tsx:620` pone el aviso de error y `App.tsx:636` lo sobrescribe
   incondicionalmente con "Comida guardada". Ella cierra la app creyendo que la
   dosis quedó registrada.
6. **La insulina de la comida se escribe sin `entryGroupId`.**
   `App.tsx:608` no pasa el tercer argumento que `saveInsulinEvent`
   (`db.ts:266-270`) acepta, y el timeline agrupa solo por `entry_group_id`.
   Tres horas después `getPendingInsulinAssociations` le vuelve a preguntar qué
   insulina fue con qué comida — justo lo que la Fase 21 dijo que eliminaba.

Menores del mismo lote: la calculadora de `MealModal` no recibe glucosa, así
que `isHypoglycemic` nunca puede dispararse ahí (`EntryModal` sí lo avisa); las
unidades tecleadas se descartan sin avisar si se apaga "Registrarla como comida
de ahora" (`MealModal.tsx:454`); y la lista de validación previa de
`attachEntryToReading` (`db.ts:1173-1176`) no creció con cetonas ni macros,
aunque su comentario promete que sí.

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
- `README.md` sigue en pie (63 líneas). La purga que lo iba a borrar se abortó;
  la decisión tomada es **reescribirlo a ~30 líneas** como puerta de entrada del
  repo en GitHub, no eliminarlo. Pendiente para la Fase 4.

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
| Una purga de docs dejó ciegos a 5 de 7 activos de `.claude/` sin un solo error | `verify:contracts` |
| El inventario de esa purga solo miraba `.claude/`: el código citaba 17 docs más | el guard escanea **todo** el repo, código incluido |

## Redeploy del backend

`apps/api` **no** se tocó desde el último despliegue salvo `packages/ai/src/prompts.ts`
(prompt del insight a `glucose-insight.v5`). El backend desplegado sigue con el
prompt anterior: es de bajo riesgo y **no urgente**. Cada redeploy consume
créditos de Abacus, así que se agrupa y no se dispara salvo que sea crítico.
