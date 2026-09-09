# Active Context

_Última actualización: 2026-09-09 (el respaldo, cableado y con sus dos fugas cerradas)._

## Ni sincronización ni datos de salud en un servidor (2026-09-04)

El plan de sincronizar las quince tablas a Supabase se escribió, se aprobó y se
descartó al día siguiente. La **Ley 21.719** entra en plena vigencia el 1 de
diciembre de 2026: guardar glucosa, insulina y comidas de terceros convierte esto
en responsable de datos sensibles —consentimiento expreso, brecha en 72 h,
derechos ARCOP, multas de 20.000 UTM— desde la primera usuaria. Un consentimiento
firmado es la **base legal**, no el cumplimiento.

`docs/adr/0007` fija tres reglas: **ningún dato de salud sale del teléfono**, **la
cuenta es solo para cobrar** y **ADR 0003 no cambia**. ⚠️ **WhatsApp reabriría
esta decisión**: Meta vería todo y nuestro backend recibiría el webhook.

La portabilidad la resuelve **`.t1a.json`**, ya cableado entero (2026-09-09):
exportar e importar desde Ajustes, con el menú de importación que ahora hospeda
MySugr y Type 1A. Tres promesas probadas — completo, sin pérdida y **sin duplicar
al importar dos veces**. Auditar el propio respaldo encontró dos fugas que ya
están cerradas y con test: **`legacyBackendSensor`** habría hecho que una
instalación nueva mostrara el sensor de otra persona, y **`therapyConfiguredAt`**
habría desbloqueado las calculadoras sobre los parámetros de fábrica si entraba
sin su perfil. `SETTINGS_NEVER_BACKED_UP` filtra al **exportar**, así que el
archivo nunca llega a contenerlas.

## Insulina activa (IOB), que era el riesgo mayor (2026-09-02)

`AGENTS.md` la prohibía. Se levantó **a propósito** (`docs/adr/0005`) porque no
tenerla era peor: una comida chica con corrección y otra cinco minutos después
producían **dos correcciones completas** por la misma glucosa. Lo encontró ella.

Cinco condiciones, en el código: modelo publicado y citado (exponencial de
LoopKit/OpenAPS, `iob.ts`), parámetros que ella configuró, resta **solo de la
mitad de corrección**, desglose entero en pantalla, y sin insulina elegida **no
hay estimación**: `undefined`, no cero. Cada dosis guarda de cuánto se compuso.
La duración por tramo se propone en Resumen → Insulina; **adoptar es de ella**.

Tres cosas salieron de revisar a mano (el subagente se cortó por gasto):

- **La ventana de dosis no cubría el modelo**: 6 h fijas contra una regular de
  8 h. El activo salía de menos, y de menos **sube** la dosis propuesta.
- **Seis pantallas prometían que la app no calcula insulina activa**, una impresa
  en el reporte clínico. Una promesa vieja no rompe nada, solo miente;
  `safetyCopy.test.ts` es el test que faltaba.
- **La pestaña salió vacía igual**: el filtro pedía una ventana que con varias
  dosis diarias no existe despierto. Ahora cuenta toda dosis rápida, recorta en la
  siguiente y usa los carbohidratos como covariable. **Comparar y adoptar son
  cifras distintas** (`reference/insulin-duration-method.md`).

## El IOB se comía la comida, y el agua entró a Nutrición (2026-09-03)

**El bug.** `bolus.ts` restaba el IOB sin tope, así que el sobrante se comía la
cobertura de carbohidratos: comió y se corrigió hace 10 min, quiere comer 20 g
más, la app proponía **0 U**. El comentario decía "solo de la corrección" y el
código hacía otra cosa; los tests **afirmaban el bug**. Ahora el descuento se
detiene en 0 y el desglose declara el activo que no se usó. Regla de Verónica, que
es la del código: **carbos nuevos = siempre te pinchas; corrección nueva = no
necesariamente** (`docs/adr/0006`). En el mismo ADR: el IOB **sí** incluye la
insulina de comida —práctica estándar de las bombas, y sin modelar COB, que sería
inferir absorción, lo seguro es contarla entera.

**La curva de efecto.** Ella dudó del resumen: "me inyecto a las 6 y recién me baja
a las 10-11, pero dice que en la tarde me dura más". El tramo nunca estuvo mal,
pero la **duración observada sufre censura**: su ventana se corta en la dosis
siguiente, y de noche no llega ninguna. La curva mide el mismo instante en todos
los episodios — aunque tiene sus propios defectos: **D1–D4 en `progress.md`**.

**Agua.** Meta diaria (IOM, override de ella), barra en Nutrición, sección en el
maestro, campo en Comida, acceso rápido, ítem de timeline, y la IA la propone desde
foto o texto. **Solo agua**: un jugo es comida, con su dosis.

## Lo que cambió el foco

El Modal Maestro es **el** formulario: `TimelineDetailModal` solo lee, y su botón
**Editar** abre el mismo componente que monta "Nueva entrada". La regla que lo
ordena todo: **el foco decide qué se abre primero y nunca qué se puede guardar.**
Al crear manda el acceso rápido; al editar manda el **contenido**. El tipo con el
que nació un registro no limita lo que se le suma después.

## Ya entregado al teléfono (`a706510`) — el detalle, en los cuerpos de commit

- **La edición retroactiva no tiene límite de tipo.** `promoteEventToEntryGroup`
  conserva id, hora, `created_at`, `source` y procedencia, en **una** transacción.
- **`ingestedAt` y la hora de una lectura externa no se mueven nunca.** Un blanco
  no es un cero. El nombre de la insulina es configuración, no un campo suelto.

## Las transacciones SQLite, cerradas (2026-08-28)

El fondo recibía la **misma conexión nativa** que la pantalla y le corría un
`BEGIN` encima; el `ROLLBACK` de una cerraba la transacción de la otra. Hoy abre
con `useNewConnection` y **toda** transacción pasa por una cola FIFO.

## Catálogo, porción, fibra y la hora del resumen (2026-09-01)

**Cuánto pesa una porción** faltaba: sin eso el catálogo caía siempre a 100 g. La
IA propone `servingGrams`, `CatalogServingModal` lo confirma —y confirmarlo lo
vuelve `'user'`—, y lo rechazado se muestra con su razón. Los macros **se muestran
por porción**, se guardan por 100 g, y la leyenda dice el denominador. **La fibra
tiene meta**: 14 g por cada 1000 kcal (IOM/ADA), piso y no techo.

**El resumen post-comida citaba la hora en UTC** (17:30 salía "21:30"). Cada marca
lleva ahora desfase local explícito (`localizeEpisodeMetrics`, **por marca**,
porque el horario de verano existe) y SQLite sigue guardando UTC. Lo que crece con
eso es lo que el modelo **puede decir**: una hora local significa algo sobre su
vida, así que el mismo cambio le prohíbe juzgar o aconsejar la hora de comer.

**Y dos bugs del botón rápido**: la dosis se escribía sin `entryGroupId` —el
timeline agrupa solo por eso— y si fallaba, el aviso de éxito la pisaba.

✅ En el teléfono (builds `03fb5c6d` y `e93ce4a2`, huella verificada en el APK).

## Reglas de proceso que sobreviven

1. Antes de agregar un campo a un formulario de comida, se mira si va en
   `MacroFields` o en otro compartido: suelto en un modal es cómo llegamos a tener
   el mismo bloque seis veces.
2. **Una decisión de datos no se verifica a ojo.** Lo que decide qué se guarda,
   qué se ve o qué es un hecho vive en un módulo puro con test: `masterModal`,
   `mealCarbMirror`, `entryTime`, `mealFields`, `meal-cart`, `entryGroupClaim`,
   `dbWriteQueue`, `mealNote`, `episode-local-time`, `nutrition-targets`, `backup`.
3. Un dato que el formulario **no ve** es un dato que el guardado borra: por eso
   `TimelineEntryGroupRaw` relee insulina, calorías, peso y presión aunque la
   fila del timeline no los muestre.

## Backlog de producto priorizado

1. **El agente de IA** (plan del 2026-09-09). Turno único con **salida
   estructurada**, no tool calling: RouteLLM devuelve las herramientas como texto
   plano, y una escritura que degrada a prosa es una entrada que nunca se guardó.
   El borrador es **del mismo tipo que el payload del Modal Maestro**, así que no
   puede ser más pobre. Micrófono y foto en el chat; se dicta, se transcribe, y
   **el texto se ve y se corrige antes de que exista borrador**. Probado contra la
   API: `gpt-audio-1.5` funciona, `m4a` se rechaza (solo wav/mp3), y audio +
   `json_schema` no se combinan — o sea audio→texto→borrador, en dos pasos.
2. **PDF y Excel más ricos** para que los lea una persona: iconografía y una
   síntesis que describe y **nunca** evalúa una dosis.
3. **Gráfico de velocidad en Resumen → Insulina** (decisión de ella, 2026-09-09).
   Se **agrega, no reemplaza**: si los otros dos calculan bien, quitarlos saca una
   variable. mg/dL por hora en pasos de 30 min hasta 4 h — dice cuándo empieza a
   bajar, cuándo pega más fuerte y cuándo se acaba, **sin línea base**, que es lo
   que lo vuelve inmune a D2. Antes hay que cerrar D1–D4 de `progress.md`.
4. **Hallazgos abiertos**: ver `progress.md`. El `source` de un carbohidrato
   importado necesita decisión de producto.

## Fuera de foco pero pendiente

- **Fase 22** — swipe animado, JS puro. **Fase 20** — widget, necesita build.
- Pendiente de ella: exclusión de episodios confundidos en Patrones.
