# System Patterns — las tres Reglas de Oro

Estas tres reglas salieron de una auditoría del código y del historial. Cada
una está respaldada por un fallo real que ya llegó al dispositivo o al reporte
médico. No son estilo: son las fronteras que hacen que esta app sea segura.

---

## Regla 1 — El dominio calcula; el `.tsx` formatea

**Todo número que la usuaria pueda leer como patrón clínico se calcula en
`packages/domain`, es puro y determinístico, y su test lo compara contra una
verdad independiente.**

Ningún componente promedia, pondera, decide procedencia ni deriva una métrica.
El componente elige rango, formatea y dibuja.

### El caso que la define: `macrosSource`

`macrosSource` (`'ai' | 'user' | 'mixed' | undefined`) dice si los macros de una
comida los estimó la IA o los escribió la usuaria. **Se imprime en el reporte
que va al control médico**, así que es una regla de dominio con consecuencia
clínica. Hoy está reimplementada en cuatro lugares con reglas distintas:

| Ubicación | |
|---|---|
| `apps/mobile/src/components/MealModal.tsx` | comparación campo a campo contra `aiMacros` |
| `apps/mobile/src/components/MealEditModal.tsx` | otra lógica campo a campo |
| `apps/mobile/src/db.ts` | `existing.macrosSource === 'user' ? 'user' : 'mixed'` |
| `apps/mobile/App.tsx` (`macrosSourceFor`) | cuarta variante |

Eso produjo **tres bugs distintos**, uno por camino: etiquetar `'ai'` pisando lo
que la usuaria escribió; inventar `'user'` desde `undefined` (lo que el propio
comentario de `MealEventSchema` prohíbe: ausente = procedencia desconocida y
**nunca** se asume confirmado por la usuaria); y `'user' → 'mixed'`, que miente
en la dirección opuesta.

**Lo correcto:** una sola función en `packages/domain`, con test, y los cuatro
sitios llamándola.

### El corolario que costó más caro: el test compara contra verdad, no contra la implementación

En el rediseño estadístico de Patrones, **372 tests estaban en verde** mientras
la pantalla publicaba +57 mg/dL donde la verdad era +10 — impreso en el PDF del
médico. Los tests verificaban `adjusted`, `sampleSize` y `confoundedCount`;
**ninguno verificaba el valor**. Un script de 40 líneas con efecto sembrado lo
encontró en un minuto.

**Un test que confirma lo que la implementación devuelve hoy no prueba nada.**
Cuando un cálculo produce un número que se lee como patrón clínico, el test
siembra una verdad conocida y comprueba que el código la recupera.

### Y la regla de limpieza de datos

Cuando una regla de exclusión empieza a borrar la mayoría de los datos, **el
problema es la regla**. Excluir episodios "confundidos" vaciaba la pantalla
(en tipo 1 se come cada 4-5 h; ninguna ventana de 5 h queda limpia) y además
sesgaba, porque las comidas altas en grasa son justo las que más se corrigen
tarde. La respuesta es **truncar y ajustar**, y declarar lo que no se pudo
ajustar — nunca obviar el dato que no viene en formato fácil.

---

## Regla 2 — La frontera de insulina es estructural, no textual

**Si un dato no debe salir, el tipo no tiene dónde ponerlo.** Una frase en el
prompt no es una garantía; un esquema sin el campo, sí.

Ejemplos vivos:
- `MealSnapshotSchema` no tiene campo de dosis → la IA de edición de comidas no
  puede ver ni tocar la insulina, por construcción.
- `EpisodeContextEvent` no tiene campo de texto → el texto libre de una nota no
  puede salir del teléfono, aunque el objeto viaje al servicio de IA.

### Regla hermana, escrita con sangre

**Cada vez que le das un dato nuevo al modelo, revisa si el filtro de salida
cubre lo que ese dato le permite decir.**

Al sumar la lista de dosis al prompt del insight, el modelo pasó a poder
afirmar superposición — *"la segunda dosis se solapó con la primera, que
todavía estaba activa"*. Eso **no es una recomendación** (los patrones de
`containsTherapyRecommendation` no lo tocaban) pero **sí es una estimación de
insulina activa**, que `AGENTS.md` prohíbe igual que recomendar una dosis. Al
crecer lo que el modelo puede decir, la frontera se angostó sola.

**Procedimiento obligatorio:** si agregas un campo al payload que va a un LLM,
en el mismo cambio (a) amplías el prompt con la prohibición explícita y (b)
agregas patrones y **tests** a `containsTherapyRecommendation`
(`packages/domain/src/ai-safety.ts`). Y mueves la versión del prompt
(`GLUCOSE_INSIGHT_PROMPT_VERSION`), porque viaja guardada con cada respuesta.

### Nunca IOB

No se estima insulina activa, no se multiplica duración × unidades, no se resta
de ninguna dosis. La duración de insulina del catálogo existe **solo** para
decidir sí/no si un episodio entra a un promedio descriptivo. Ningún
coeficiente de `regression.ts` puede salir de `macro-glucose.ts`: un β sobre
una columna de unidades de insulina es, dimensionalmente, un factor de
corrección inferido — justo lo que `AGENTS.md` prohíbe.

---

## Regla 3 — Los identificadores son inmutables; lo que se guarda junto comparte un id

### 3a — Un identificador que ya salió del repo no se renombra

Sobreviven al build: notificaciones ya posteadas en la bandeja, deep links
guardados, payloads en SQLite, ids del catálogo persistidos en el perfil.

Renombrar `ACTION_CARBS` deja un botón muerto **sin ningún error visible**. Al
fusionar destinos se mantiene el id viejo y se agrega una **función de
normalización explícita con test** (`normalizeQuickRoute`), nunca un `as`
silencioso: el `as` compila y el botón sigue sin hacer nada.

Regla hermana: **al apretar un esquema Zod, revisa qué podría producir
legítimamente el valor que estás excluyendo.** Un `.positive()` agregado por
prolijidad rompió, una corrida después, el caso legítimo de un evento anterior
al ancla.

### 3b — Agrupar por `entry_group_id`, jamás por timestamp

Emparejar filas por hora es la **causa raíz documentada** del bug
insulina↔comida: cada acceso rápido escribía su fila con su propio timestamp, y
la app después no encontraba qué dosis correspondía a qué carbohidratos.

Todo lo que se guarda en un mismo acto comparte `entry_group_id`. Cuando se
agregó el campo de cetonas se le puso columna propia en `vitals_events` por esta
razón, en vez de emparejarlas por hora.

Corolario: **no documentes garantías que no existen.** Un comentario en `db.ts`
afirmaba que las cetonas sueltas se mostraban en el timeline; `getTimeline`
nunca tuvo esa rama. La corrida siguiente habría confiado en él.

