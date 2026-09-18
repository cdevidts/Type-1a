# Active Context

_Última actualización: 2026-09-18 (insulina activa: etiquetas, horas y asociación)._

## El agente: el andamio y el turno (2026-09-10)

`docs/adr/0008`. **Salida estructurada, no tool calling**: RouteLLM devuelve las
llamadas a herramienta como **texto plano**, y una escritura que degrada a prosa
significa que el modelo dice "listo, registré tu comida" y no se escribió nada.
(El audio medido quedó en el 0008; el 0009 lo reemplaza.)

**El registro es código**: `agent-tools.ts` declara qué alcanza y qué no con su
motivo, y `verify:contracts` falla si una función de `db.ts` no está en ninguna
lista: cazó una sin clasificar, y un test cazó ocho motivos de relleno míos.
**El borrador es del mismo tipo que el payload del Modal Maestro**, y `saveTherapyProfile` no es alcanzable: nunca.

**La insulina activa, revisada entera (2026-09-18).** Ella vio 5,98 U en una
pantalla y 2 U en otra, en el mismo minuto: no era el cálculo, era **la etiqueta
valiendo dos cantidades**. De ahí salió una auditoría con doce hallazgos, y el
peor lo había introducido yo ese mismo día: un "hace 3 horas" retrofechaba una
dosis recién puesta y la corrección siguiente proponía **de más**. Quedó cerrado
por adyacencia, con test. También: la app **preguntaba por asociaciones que ya
sabía** (comida e insulina comparten `entry_group_id` y nadie lo consultaba —
Regla 3b donde faltaba), y la sincronización pedía **4 h fijas**, así que un
hueco más largo no se pedía nunca. ⚠️ **Abierto y de ella**: si la insulina de
comida debe contar como activa contra una corrección nueva (`docs/adr/0006`).

**Lo que el teléfono enseñó y el repo no.** El micrófono salió **sin permiso**
(otro plugin lo bloqueaba) y el asistente estaba "tonto" por **cableado
ausente**, no por el modelo. **La lección: un permiso y un cableado se verifican
en el artefacto —el manifiesto generado, el APK, el endpoint en vivo—, no en el
código fuente.**

**El dictado no manda audio a ninguna parte** (`docs/adr/0009`). El plan del 0008
—subir el archivo— murió contra un hecho que no miré: Android no graba en wav ni
mp3, los únicos formatos que el modelo acepta. Lo hace el reconocedor del sistema:
se transcribe **en el teléfono** cuando el aparato puede (si no, se pide permiso
antes de grabar), las pistas de vocabulario **no salen** si no es local, y **el
micrófono es un teclado, no un botón de enviar.**

**El dictado ya no escribe en el log del sistema**: se intentó comprimiendo la
app con la regla que Android recomienda, **se construyó el APK y no borró nada**.
Una regla de ProGuard no se verifica desde acá; un parche de la dependencia sí.

**El botón del chat ya existía y yo agregué otro** (posición 4 de la barra, con
el logo). Hoy `chat` entró al swipe, pero su modal **no** lleva `swipeHandlers`:
adentro hay un cuadro de texto, y eso es un formulario.

## Ni sincronización ni datos de salud en un servidor (2026-09-04)

`docs/adr/0007`, tras entender la **Ley 21.719** (plena vigencia el 1 de diciembre
de 2026, datos de salud = máxima protección, multas de 20.000 UTM). Tres reglas:
**ningún dato de salud sale del teléfono**, **la cuenta es solo para cobrar**, y
**ADR 0003 no cambia**. Un consentimiento firmado es la base legal, no el
cumplimiento. ⚠️ **WhatsApp reabriría esto**: Meta vería todo.

La portabilidad la resuelve **`.t1a.json`**, cableado y en el teléfono desde el
build `444a3ff3`. Tres promesas probadas — completo, sin pérdida y **sin
duplicar**. Auditarlo encontró dos fugas, cerradas y con test:
**`legacyBackendSensor`** habría hecho que una instalación nueva mostrara el
sensor de otra persona, y **`therapyConfiguredAt`** habría desbloqueado las
calculadoras sobre los parámetros de fábrica. `SETTINGS_NEVER_BACKED_UP` filtra
al **exportar**. En la misma corrida salieron las fotos de la caché, que Android
vacía sola: `photos.ts` las guarda en `Paths.document` y migra las viejas.

## Insulina activa (IOB), que era el riesgo mayor (2026-09-02)

`AGENTS.md` la prohibía. Se levantó **a propósito** (`docs/adr/0005`) porque no
tenerla era peor: dos comidas seguidas producían **dos correcciones completas**
por la misma glucosa. Lo encontró ella.

Cinco condiciones, en el código: modelo publicado y citado (exponencial de
LoopKit/OpenAPS), parámetros que ella configuró, resta **solo de la mitad de
corrección**, desglose entero en pantalla, y sin insulina elegida **no hay
estimación**: `undefined`, no cero. Tres cosas salieron de revisar a mano: la
ventana pedía 6 h contra una regular de 8 y el activo **de menos sube** la dosis;
**seis pantallas prometían que la app no calcula insulina activa** el día que
empezó a calcularla (`safetyCopy.test.ts`); y la pestaña salió vacía por un filtro
que con varias dosis diarias no encuentra nada despierto.

## El IOB se comía la comida, y el agua entró a Nutrición (2026-09-03)

**El bug.** `bolus.ts` restaba el IOB sin tope, así que el sobrante se comía la
cobertura de carbohidratos: comió y se corrigió hace 10 min, quiere 20 g más, la
app proponía **0 U**. El comentario decía "solo de la corrección" y el código
hacía otra cosa; los tests **afirmaban el bug**. Regla de ella, que es la del
código: **carbos nuevos = siempre te pinchas; corrección nueva = no
necesariamente** (`docs/adr/0006`). En el mismo ADR: el IOB **sí** incluye la
insulina de comida —práctica estándar de bombas, y sin modelar COB lo seguro es
contarla entera.

**La curva de efecto** existe porque ella dudó del resumen. El tramo nunca estuvo
mal, pero la duración observada **sufre censura**: su ventana se corta en la dosis
siguiente. La curva no tiene ese sesgo, aunque tiene **D1–D4 abiertos**
(`reference/insulin-duration-method.md`).

**Agua.** Meta diaria, barra en Nutrición, sección en el maestro, acceso rápido, y
la IA la propone desde foto o texto. **Solo agua**: un jugo es comida, con su dosis.

## Lo que cambió el foco

El Modal Maestro es **el** formulario: `TimelineDetailModal` solo lee, y su botón
**Editar** abre el mismo componente que monta "Nueva entrada". La regla que lo
ordena todo: **el foco decide qué se abre primero y nunca qué se puede guardar.**
Al crear manda el acceso rápido; al editar manda el **contenido**. El tipo con el
que nació un registro no limita lo que se le suma después.

## Ya entregado al teléfono (`a706510`) — el detalle, en los cuerpos de commit

- **La edición retroactiva no tiene límite de tipo**: `promoteEventToEntryGroup`
  conserva id, hora, `created_at`, `source` y procedencia, en una transacción.
- **`ingestedAt` y la hora de una lectura externa no se mueven nunca.** Un blanco
  no es un cero; el nombre de la insulina es configuración, no un campo suelto.

## Cerrado y en el teléfono (2026-08-28 / 09-01)

**Transacciones SQLite**: el fondo recibía la misma conexión nativa que la
pantalla y el `ROLLBACK` de una cerraba la de la otra. Hoy `useNewConnection` y
cola FIFO. **Porción**: la IA propone `servingGrams` y ella confirma
(confirmarlo lo vuelve `'user'`); se muestra por porción, se guarda por 100 g.
**Fibra**: meta de 14 g/1000 kcal (IOM/ADA), piso y no techo. **La hora del
resumen salía en UTC**; cada marca lleva desfase local (`localizeEpisodeMetrics`,
por marca, porque el horario de verano existe), y como una hora local dice algo
de su vida, el mismo cambio le prohíbe al modelo juzgar a qué hora come.
(`03fb5c6d`, `e93ce4a2`)

## Reglas de proceso que sobreviven

1. Antes de agregar un campo a un formulario de comida, se mira si va en
   `MacroFields` u otro compartido: suelto en un modal es cómo llegamos a tener
   el mismo bloque seis veces.
2. **Una decisión de datos no se verifica a ojo.** Lo que decide qué se guarda,
   qué se ve o qué es un hecho vive en un módulo puro con test: `masterModal`,
   `mealCarbMirror`, `entryTime`, `mealFields`, `meal-cart`, `entryGroupClaim`,
   `dbWriteQueue`, `mealNote`, `episode-local-time`, `nutrition-targets`,
   `backup`, `agent-tools`, `agent-context`, `local-intent`.
3. Un dato que el formulario **no ve** es un dato que el guardado borra: por eso
   `TimelineEntryGroupRaw` relee insulina, calorías, peso y presión.

## Backlog de producto priorizado

1. **Gráfico de velocidad en Resumen → Insulina** (decisión de ella): se
   **agrega, no reemplaza**. mg/dL por hora en pasos de 30 min hasta 4 h; por
   ser derivada no usa línea base y es inmune a D2. **Antes hay que cerrar
   D1–D4** (`reference/insulin-duration-method.md`), o quedan tres gráficos y
   dos mintiendo.
2. **PDF y Excel más ricos**: describen y **nunca** evalúan una dosis.
   **Hallazgos abiertos**: ver `progress.md`.
3. **Fase 22** — swipe animado. **Fase 20** — widget, necesita build. Pendiente
   de ella: exclusión de episodios confundidos en Patrones.
