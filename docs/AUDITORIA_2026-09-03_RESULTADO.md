# Auditoría de UI/UX y escenarios — resultado (2026-09-03)

Ejecutada sobre `6ebda98`. Los números de la Parte A salen de **correr el
dominio real**, no de leer el código: se escribió una suite temporal que llama
`calculateMealBolus`, `activeInsulinUnits`, `waterTargetMl` y `buildReportRows`
y vuelca lo que la app diría.

**Resultado: 12 escenarios correctos, 5 hallazgos.** Todos corregidos.

---

## Parte A — Escenarios

### A1 · La familia del bug del IOB

| # | Escenario | Lo que la app dice hoy |
|---|---|---|
| A1.1 | **Su caso literal**: 7+3 U hace 10 min, ahora 20 g, glucosa 110 · IOB 9,84 U | **2 U** — comida 2, corrección 0, IOB aplicado 0, sin usar 9,84. ✅ |
| A1.2 | Igual con glucosa 260 (corrección teórica 3 U) | **2 U** — la corrección se anula entera (aplicado 3) y quedan los 2 U de comida. ✅ |
| A1.3 | Igual con glucosa 70 | **1 U** — la corrección negativa (−0,8) sí baja el total; el IOB no descuenta nada más. ✅ |
| A1.4 | Corrección de 3 U hace 10 min, ahora glucosa 250 · IOB 2,95 U | **0 U** (sin IOB pedía 2,8 U). Es el stacking evitado. ✅ |
| A1.5 | Sin insulina elegida en Ajustes · 20 g · glucosa 260 | **5 U**, y `activeInsulinUnits` es `undefined`, no 0. ✅ |
| A1.6 | Regular humana (8 h) con dosis de hace 7 h | IOB **0,19 U**, 1 dosis. Con la ventana vieja de 6 h daba 0. ✅ |
| A1.7 | Override de 8 h en la mañana · misma dosis hace 4 h | mañana **0,4 U** vs. tarde **0,12 U**. El tramo cambia la curva. ✅ |

El caso que ella planteó da **2 U**, que es lo correcto: los 20 g nuevos llevan
su dosis completa y las 9,84 U activas no la tocan.

### A2 · Agua

| # | Escenario | Resultado |
|---|---|---|
| A2.9 | Foto con un jugo que la IA no puso en `foods` | descartado; con agua sola se acepta. ✅ |
| A2.11 | Restricción de 1.000 mL escrita en Metas, bebió 1.000 | meta **1.000 mL** (no sube al piso), 100 %, faltan 0. ✅ |

### A3 · Lo que se imprime

| # | Escenario | Resultado |
|---|---|---|
| A3.15 | Dosis de 2 U = 2 comida + 3 corrección − 3 activas | `2 U · Rápida · comida + corrección · 2 U de comida · 3 U de corrección · menos 3 U activas` — la resta declarada es la aplicada y 2 + (3−3) = 2 cuadra. ✅ |
| A3.17 | Un día con agua registrada | **0 filas.** ❌ **Hallazgo 3** |

---

## Hallazgos y qué se hizo

### 1 · La barra de agua no se veía si no habías comido — GRAVE

`NutritionModal` cortaba al estado vacío cuando el día no tenía comidas ni
carbohidratos, **sin mirar el agua**. Un día con 2 litros registrados y sin
comida caía en "Sin comidas registradas este día": el dato se guardaba, sumaba
a la meta, y no había dónde mirarlo. Es la misma falla que tuvieron las cetonas
sueltas, y exactamente lo que Verónica pidió que no volviera a pasar.

**Corregido**: el agua cuenta como contenido del día. Y si hay agua pero no
comidas, se declara que los macros en cero son "no anotaste", no "no comiste" —
una barra vacía sin esa nota se lee como un incumplimiento.

### 2 · La duración observada medía sobre glucosa sintética — GRAVE

`observeCorrectionsFrom` no filtraba `origin: 'synthetic'`. Todo el resto del
dominio sí (`glucose-metrics`, `agp`, `nutrition-insights`, el PDF, y la curva
nueva). El problema no es cosmético: esa cifra **se puede adoptar**, y adoptarla
alimenta el IOB. Datos del modo demo decidiendo cuánta insulina se descuenta de
cada corrección real.

**Corregido**, con test que compara el mismo episodio real contra su copia
sintética.

### 3 · El agua no llegaba al reporte del equipo clínico

Se veía en Nutrición y en el timeline, y no salía ni en el PDF ni en el Excel.
En tipo 1 la sed excesiva puede ser síntoma de hiperglucemia: un día de 4 litros
al lado de unas glucosas altas dice algo que un día de 800 mL no dice.

**Corregido**: `ReportRowKind` gana `'water'`, con procedencia que distingue lo
que estimó la IA ("Estimado por IA (foto)") de lo que ella escribió. Un volumen
que produjo un modelo no puede llegar al médico como un dato medido.

### 4 · Tres juegos distintos de tamaños de vaso

Escritos tres veces y ya divergidos: maestro 200/250/500, Comida 250/500,
acceso rápido 200/250/500/750. Misma disciplina que la Regla 1 —una decisión, un
sitio— aunque aquí lo que se rompe sea la consistencia y no un número clínico.

**Corregido**: `WATER_PRESETS_ML` en `packages/domain`, consumido por los tres.

### 5 · El quinto acceso rápido dejaba media fila vacía

Cinco botones en una grilla de dos columnas. **Corregido**: el de Agua va último
y a ancho completo. Va último porque es el de menor consecuencia clínica de los
cinco: el peso visual sigue el orden de importancia, no el de llegada.

---

## Revisado y sin hallazgo

- **44×44 pt** en todo lo tocable nuevo (tres juegos de atajos, botones de
  adoptar duración).
- **Unidad junto al campo** en los cuatro sitios donde se escribe agua.
- **Sin hex ni fontSize inventados** en lo nuevo. Los `#FFFFFF` que aparecen
  son texto sobre botón de color, patrón preexistente y consistente.
- **Las 7 secciones del maestro declaradas se renderizan las 7.** Así se
  encontró la de agua cuando faltaba; ahora no falta ninguna.
- **`MealEditModal`**: declara el agua que la IA vio y ofrece la salida al
  maestro. No la registra **a propósito** — es el editor de la *comida*, y
  duplicar el campo en dos editores es cómo nació el bug de `macrosSource`.
  Decisión, no deuda.

---

## Lo que queda para después

- Los escenarios A2.12–A2.14 (editar, borrar y mover una entrada con agua) se
  verificaron por lectura del código, no ejecutándolos: `db.ts` no tiene banco
  de pruebas de SQLite. Los cuatro caminos están corregidos desde `0574b26`,
  pero merecen prueba real en el teléfono.
- El redeploy del backend sigue pendiente: hasta entonces la IA no detecta agua
  y las fotos siguen dando 502.
