# DIRECTIVA MAESTRA DE IMPLEMENTACIÓN

## Type 1A — edición retroactiva completa, navegación histórica y nutrición

### Rol y misión

Eres el Principal Software Engineer y Regression Owner de **Type 1A**, una aplicación Android-first utilizada con datos reales por una persona con diabetes tipo 1. Trabaja sobre el repositorio `https://github.com/cdevidts/Type-1a` y toma como base la rama `main` actualizada.

Esta es una sesión nueva: no presupongas decisiones de conversaciones anteriores ni implementaciones que no estén realmente en el código. Lee este documento completo, inspecciona el repositorio y ejecuta de punta a punta los catorce cambios aquí definidos.

Hay historial clínico local sin respaldo en la nube. Una migración incorrecta o una edición a medias puede destruir información irrecuperable. Prioriza integridad, compatibilidad con datos existentes, transacciones y verificaciones reales.

No hagas push ni abras un PR. Crea una rama de trabajo desde `main` actualizada, por ejemplo `feat/retroactive-master-calendar-nutrition`, y deja un commit local siguiendo la convención del repositorio.

---

## Protocolo obligatorio antes de modificar código

1. Ejecuta `git status`, identifica cambios preexistentes y no los sobrescribas.
2. Actualiza las referencias remotas y confirma desde qué commit de `main` partes.
3. Lee completos, no de memoria:
   - `AGENTS.md` y cualquier `AGENTS.md` aplicable dentro de `apps/mobile`.
   - `CLAUDE.md`.
   - `memory-bank/projectbrief.md`.
   - `memory-bank/activeContext.md`.
   - `memory-bank/progress.md`.
   - `memory-bank/codemap.md`.
   - `contracts/safety-acceptance.md`.
   - `contracts/ux-checklist.md`.
   - El `package.json` raíz y los paquetes relevantes antes de asumir comandos.
4. Audita la implementación real, especialmente:
   - `apps/mobile/App.tsx`.
   - `apps/mobile/src/masterModal.ts` y sus tests.
   - `apps/mobile/src/components/UnifiedEntryModal.tsx`.
   - `apps/mobile/src/components/TimelineDetailModal.tsx`.
   - `apps/mobile/src/components/MealModal.tsx`.
   - `apps/mobile/src/components/MealEditModal.tsx`.
   - `apps/mobile/src/components/NutritionModal.tsx`.
   - `apps/mobile/src/components/CatalogModal.tsx`.
   - `apps/mobile/src/components/CatalogQuickAdd.tsx`.
   - `apps/mobile/src/components/BottomNav.tsx`.
   - `apps/mobile/src/components/EntrySection.tsx` y `MacroFields.tsx`.
   - `apps/mobile/src/db.ts`, en particular las escrituras `save*`, `update*`, `attachEntryToReading`, `updateUnifiedEntryGroup`, la sincronización de carbohidratos confirmados, `getTimeline` y las migraciones SQLite.
   - Las notificaciones de episodios y sus identificadores/cancelaciones.
   - Los esquemas y funciones de dominio relacionados con comidas, catálogo, macros, nutrición, episodios y procedencia.
5. Registra la línea base: resultado de `pnpm verify`, cantidad de tests y módulos del bundle. No atribuyas a esta tarea un fallo previo sin demostrarlo.

Los nombres de archivo citados describen el estado conocido de `main`, pero el código es la fuente de verdad. Si una conversación antigua menciona archivos inexistentes como `MealCart.tsx` o `catalog-cart.ts`, no inventes que ya existen: créalos únicamente si son la separación correcta para la implementación final.

---

## Estado actual verificado que debes comprender

No partas de una descripción ficticia. En el `main` conocido al redactar esta directiva:

- `UnifiedEntryModal` sirve principalmente para crear. La edición general todavía vive como formulario inline limitado dentro de `TimelineDetailModal`.
- Una comida existente tiene un `MealEditModal` bastante potente: cámara, IA por texto, instrucciones libres, propuesta antes/después y edición de macros. **No debes degradarlo ni reconstruirlo como un formulario más pobre.**
- El hueco principal está al editar una glucosa o una entrada que todavía no contiene comida: allí no existen las facultades completas de foto, IA, catálogo y carrito.
- El catálogo rápido agrega un alimento por vez; todavía no es un carrito multi-alimento.
- `NutritionModal` está fijado a “hoy”; `onLoadDay` no recibe una fecha seleccionada.
- La fila `carb_events` con `source: 'meal_confirmed'` funciona como espejo interno de los carbohidratos de una comida. En registros no agrupados puede aparecer además en el Timeline como si fuera un segundo hecho independiente.
- La fibra ya existe en varios esquemas y formularios. No la vuelvas a implementar donde ya funciona: audita paridad y completa solamente las superficies donde todavía está relegada o ausente.
- El catálogo actual no persiste una imagen propia del alimento. Si la UI final necesita mostrarla, la solución incluye modelo, migración, lectura, escritura y fallback para datos antiguos.
- Los accesos rápidos de Basal y Cetonas actualmente pueden terminar en el maestro; la experiencia final requerida vuelve a separarlos como flujos breves y dedicados.

---

## Principio arquitectónico rector

**El foco decide qué se abre primero; nunca debe limitar lo que se puede agregar o guardar retroactivamente.**

Al editar un registro, el tipo con el que nació no restringe los datos que se le pueden sumar después. Si falta una ruta de persistencia, no ocultes la capacidad y tampoco muestres un campo que simule guardar: construye primero la ruta transaccional y después habilita la interfaz.

La experiencia debe sentirse como un único Modal Maestro, aunque internamente reutilice componentes especializados. Reutiliza las capacidades maduras de `MealEditModal`, `MealModal`, `MacroFields` y la calculadora; no mantengas implementaciones paralelas que diverjan.

---

## Invariantes clínicos y de datos

Estas reglas no se negocian:

- La aplicación nunca calcula, infiere ni recomienda insulina por iniciativa propia. La calculadora solo aplica aritmética determinista a parámetros que la usuaria configuró.
- No implementes ni descuentes insulina activa (IOB).
- IA, catálogo y carrito producen estimaciones. Nunca escriben por sí solos `carbohidratos confirmados`; hace falta una acción explícita de la usuaria.
- La calculadora solo puede usar carbohidratos confirmados, nunca el total tentativo del carrito ni una estimación de IA o catálogo.
- Glucosa de sensor, importada o sintética mantiene su valor, origen y timestamp de fuente como dato de solo lectura. No la conviertas en manual. Si un grupo contiene datos añadidos por la usuaria, esos adjuntos sí pueden editarse sin falsificar la lectura externa.
- `sourceTimestamp` e `ingestedAt` conservan significados distintos. `ingestedAt` nunca se mueve para fingir otro momento de ingestión.
- En blanco no significa cero. Un borrado requiere intención explícita; una ausencia o un campo no tocado no borra datos.
- La procedencia de macros se resuelve de manera central, con la función de dominio correspondiente. Nunca marques como `user` una estimación.
- Un fallo de IA, cámara, catálogo o CGM degrada a registro manual y lo comunica; no bloquea la captura.
- Valida entradas externas y salidas de IA con los esquemas existentes.
- Ningún estado importante se comunica exclusivamente mediante color.
- Mantén áreas táctiles accesibles y los contratos de seguridad/UX del repositorio.
- No dupliques comidas, grupos, episodios, notificaciones ni hechos clínicos visibles.

---

# Los catorce cambios aceptados

## 1. Sustituir el editor primitivo por el Modal Maestro

El Timeline sigue abriendo primero `TimelineDetailModal` en modo lectura. La usuaria revisa el registro y luego pulsa **Editar**.

Desde ese botón, todo registro histórico editable debe entrar en una experiencia coherente de Modal Maestro, no en los formularios inline primitivos actuales. Episodios calculados continúan siendo de lectura/borrado, no formularios editables.

Requisitos:

- Elimina la edición inline duplicada de `TimelineDetailModal` cuando el maestro cubra sus rutas.
- Unifica las reglas de secciones, foco, título, semilla y persistencia en funciones puras probables, preferentemente en `masterModal.ts`.
- Secciones del maestro: Glucosa, Comida, Calculadora de dosis, Insulina, Cetonas/Vitales y Nota.
- Abre las secciones que ya contienen datos y deja las demás plegadas, pero disponibles.
- Una comida existente conserva toda la potencia de su editor actual. Integra o reutiliza `MealEditModal`; no lo reemplaces por campos básicos.

Criterio de aceptación: editar glucosa, insulina, carbohidratos históricos, comida, nota, entrada empaquetada y cetonas/vitales conduce a una experiencia maestra consistente y cada campo visible tiene persistencia demostrada.

## 2. Hacer la edición retroactiva independiente del tipo original

Un evento suelto debe poder convertirse en una entrada agrupada y recibir el resto de las secciones.

Construye una operación transaccional de promoción/generalización, reutilizando el patrón de `attachEntryToReading` y `updateUnifiedEntryGroup` en vez de crear caminos competidores.

Debe:

- Conservar id, timestamp, `created_at`, `source`, `origin` y procedencia del evento original.
- Asignar un `entry_group_id` una sola vez.
- Ser idempotente ante doble toque/reintento.
- No borrar y recrear el evento original.
- No duplicar el episodio existente de una comida.
- Crear exactamente un episodio si al grupo se añade una comida donde antes no había.
- Revertirse completa si falla a mitad.

Criterio de aceptación: desde una insulina, nota, carbohidrato o comida suelta se pueden añadir los demás datos y el Timeline termina mostrando una sola entrada coherente.

## 3. Dar a la edición de una glucosa todas las herramientas de comida

Esta es la corrección conceptual más importante: **el problema no es que el editor de comidas existente carezca de IA; el problema es que al editar una glucosa sin comida solo aparece un formulario básico.**

Al editar una glucosa —incluida una lectura externa cuyo valor permanece de solo lectura— la sección Comida debe permitir crear y adjuntar una comida con:

- Búsqueda real en el catálogo.
- Carrito multi-alimento.
- Cámara y estimación por foto.
- Estimación por descripción de texto.
- Descripción, carbohidratos confirmados, proteína, grasa, fibra y calorías.
- Persistencia de `imageUri`, id/análisis de IA, carbohidratos estimados y procedencia correcta.
- Fallback manual si IA/cámara falla.

La misma paridad aplica cuando se agrega por primera vez una comida a cualquier otro registro editable que todavía no la tenga.

Criterio de aceptación: una glucosa de anteayer puede recibir hoy una comida completa con foto/IA/catálogo/carrito sin modificar el valor ni la procedencia de la glucosa.

## 4. Unificar comida y carbohidratos como un solo registro visible

Hoy una comida puede producir un `MealEvent` y además una fila espejo `CarbEvent` con `source: 'meal_confirmed'`. Esa fila puede ser necesaria internamente, pero para la usuaria no son dos acontecimientos.

Objetivo:

- Cada comida aparece una sola vez en Timeline, Nutrición, búsquedas y reportes.
- Sus carbohidratos forman parte de esa comida.
- Un carbohidrato verdaderamente manual y suelto sigue apareciendo como evento independiente.
- Un `meal_confirmed` asociado a una comida nunca aparece como tarjeta separada ni se cuenta dos veces.
- Datos históricos que ya tengan ambas filas se deduplican al leer sin perder información.
- Si se llega a una antigua fila espejo desde alguna ruta, **Editar** abre la comida correspondiente, no un campo primitivo de gramos.
- Editar, mover o borrar una comida mantiene sincronizadas todas las representaciones internas.

No elimines a ciegas la fila espejo si el dominio, los reportes o el borrado todavía dependen de ella. Decide después de auditar. La aceptación es una sola verdad visible y cero doble conteo, no una forma específica de tabla.

## 5. Completar —sin degradar— la edición de una comida existente

Conserva lo que `MealEditModal` ya hace bien:

- Foto nueva y reanálisis.
- IA por texto.
- Instrucción libre como “en realidad fue media porción”.
- Propuesta antes → después.
- Confianza e incertidumbre.
- Aplicar/descartar.
- Carbohidratos confirmados separados de la estimación.
- Edición de macros y calorías.

Añade lo que falta:

- Catálogo y carrito multi-alimento dentro de la edición.
- Imagen guardada visible al abrir.
- Acciones claras para reemplazar o quitar la imagen guardada.
- Diferencia visual entre imagen guardada y nueva propuesta sin aplicar.
- Una foto nueva solo reemplaza la anterior cuando la propuesta/análisis correspondiente se aplica; no dejes foto y análisis desalineados.

## 6. Añadir Strip Calendar a Nutrición

La pantalla de Nutrición deja de estar bloqueada en “Hoy”.

Construye en su parte superior:

- Selector/navegación de mes.
- Fila horizontal desplazable de días en círculos, con letra del día y número: L, M, X, J, V, S, D.
- Estado seleccionado inequívoco, no comunicado solo por color.
- Navegación fluida entre meses y retorno sencillo a hoy.
- Fechas futuras deshabilitadas para registro.

Seleccionar un día recarga **toda** la información dependiente de la fecha: comidas, carbohidratos sueltos, energía, macros y fibra. Cambia `onLoadDay` y las consultas para recibir un rango diario explícito; no filtres siempre contra `new Date()`.

Conserva los patrones históricos de 90 días como una pregunta distinta de la vista del día seleccionado. No dejes que cambiar el día rompa la ventana analítica de patrones.

## 7. Hacer contextual el botón “+” al registrar en el pasado

Cuando Nutrición tiene seleccionado un día anterior:

- El botón central “+” cambia de color/estilo y añade además una señal textual o accesible que indique “Agregar al pasado”.
- Al volver a hoy, cerrar Nutrición o navegar a otro destino, recupera su estado normal.
- Pulsarlo abre “Nueva entrada” heredando la fecha seleccionada.
- Antes de permitir guardar, solicita de forma protagonista la hora exacta de ese día. No guarde silenciosamente “ahora” ni un mediodía inventado.
- La fecha heredada no se pierde al usar cámara, IA, catálogo, volver del segundo plano o plegar secciones.
- Rechaza una combinación fecha/hora futura.

La navegación normal desde fuera de Nutrición sigue creando con fecha/hora actual.

## 8. Permitir corregir fecha y hora de los registros

Todo registro introducido por la usuaria debe mostrar y permitir corregir su fecha/hora desde la edición. Las marcas de tiempo provenientes de sensor/importación conservan la verdad de su fuente; en grupos anclados a ellas, mueve solo los datos editables sin falsificar la lectura externa.

Implementa el movimiento como una única transacción y audita todas las copias:

- Columnas `timestamp` y `payload.timestamp` de eventos locales.
- En lecturas manuales, los campos temporales que representan la medición.
- Nunca cambies `ingestedAt` para simular otra ingestión.
- Todas las filas del mismo `entry_group_id` que deban representar el mismo momento.
- `meal_episodes.meal_timestamp`.
- La fila espejo `carb_events` de `meal_confirmed`, si sigue existiendo.
- Cualquier índice, relación o lookup dependiente del timestamp.

Después de mover una comida:

- Devuelve el episodio a estado recalculable, invalida métricas/insight obsoletos y reprocesa la ventana correcta.
- Cancela primero las notificaciones antiguas del episodio y después programa solo las nuevas.
- Evita alarmas duplicadas.

Rechaza fechas futuras con un mensaje comprensible.

## 9. Restaurar la calculadora en edición histórica

La sección Calculadora está disponible también al editar.

En modo edición, su título principal debe ser exactamente:

> ¿Se te olvidó cuánto te pinchaste?

Dentro de la propia sección muestra un bloque de advertencia prominente con la fecha/hora de la glucosa y una explicación inequívoca: el cálculo reconstruye el contexto histórico y **no es una sugerencia para inyectarse ahora**.

Conserva todas las guardas:

- Terapia configurada por la usuaria.
- Rechazo de glucosa sintética como base clínica.
- Fórmulas deterministas existentes para comida/corrección.
- Desglose y parámetros utilizados.
- Advertencia de hipoglucemia.
- Aviso de que no descuenta IOB.
- Invalidación del resultado si cambian glucosa o carbohidratos.
- El resultado no se copia automáticamente: solo pasa a Rápida mediante una acción explícita “Usar N U”.
- Entrada de carbohidratos exclusivamente confirmados.

## 10. Hacer editables cetonas y vitales sin destruir campos hermanos

Una medición mal escrita no debe obligar a borrar y recrear el registro.

Implementa una actualización `merge` sobre el payload existente, validada con el esquema correspondiente:

- Corregir cetonas no borra peso ni presión de la misma fila.
- Corregir peso o presión, si esos datos están presentes/soportados por el formulario, no borra cetonas.
- Un campo no tocado permanece intacto.
- Vaciar exige una acción explícita de eliminación; ausencia no equivale a borrado.
- La evaluación clínica de cetonas sigue proviniendo de la función de dominio y se muestra con texto, no solo color.

## 11. Obtener el nombre de la insulina desde Ajustes → Terapia

El nombre de insulina no es un campo de texto por registro.

Requisitos:

- Elimina el input libre de los formularios de creación y edición.
- Muestra el nombre como dato de solo lectura y ofrece ir a Ajustes → Terapia para cambiar la configuración.
- Al escribir una rápida usa el nombre/identificador rápido configurado; para basal usa el basal.
- Estampa el nombre al crear el registro. Si la usuaria cambia de tratamiento después, el historial antiguo conserva lo que se usaba entonces.
- Cambiar el tipo rápida ↔ basal durante una edición reestampa el nombre correspondiente al nuevo tipo.
- Si no hay insulina configurada, no inventes un valor; comunícalo.
- Un evento con `source: 'imported'` conserva estrictamente el nombre de su fuente.
- `updateUnifiedEntryGroup` y cualquier actualización parcial no pueden borrar silenciosamente un nombre existente.
- Revisa todos los caminos: nueva entrada, corrección, comida, basal, promoción y edición agrupada.

## 12. Rediseñar visualmente Catálogo y Carrito

En la pestaña Catálogo —el destino a la izquierda del “+”— cada alimento debe mostrar:

- Foto cuadrada con esquinas redondeadas a la izquierda.
- Nombre y descripción/porción.
- Chips pequeños y coloreados para Carbohidratos, Proteína, Grasa y Fibra, usando el design system y texto legible.
- Un lápiz a la derecha como única acción para editar.
- Tocar el contenedor completo no debe abrir edición accidentalmente.
- La eliminación continúa siendo explícita y confirmada.

El carrito dentro de los flujos de comida reutiliza la misma tarjeta visual, excepto que el control derecho es una “X” para quitar la línea, no el lápiz.

Como el catálogo actual no guarda imágenes, extiende de forma completa y compatible:

- Tipo/esquema de dominio.
- Esquema SQLite y migración aditiva.
- Inserción, actualización, mezcla y lectura.
- Persistencia desde una comida/foto real; no generes ni inventes imágenes.
- Fallback visual claro para alimentos históricos sin foto.

No uses la imagen para inferir macros durante la lectura del catálogo; solo es representación del alimento guardado.

## 13. Construir un carrito multi-alimento real

Reemplaza la selección única por un carrito acumulativo disponible al crear una comida, al añadirla a una glucosa/otro registro y al editar una comida existente.

Debe permitir:

- Buscar de verdad en todo el catálogo guardado.
- Agregar Pan + Queso + Jamón sin que el segundo reemplace al primero.
- Conservar por línea la identidad del alimento, modo porciones/gramos y cantidad.
- Editar cantidad y quitar cada línea con “X”.
- Recalcular al instante carbohidratos, proteína, grasa, fibra y calorías.
- Mantener visible un banner de estimación mientras haya líneas.
- Mostrar cantidad de alimentos y desglose.
- Si falta un macro en algún alimento, marcar el total como mínimo/incompleto y nombrar cuáles faltan.

El total del carrito sigue siendo tentativo. Debe existir una acción explícita para usar sus carbohidratos como valor confirmado. Modificar el carrito después invalida cualquier cálculo de dosis basado en un total anterior.

Preserva la regla existente de las tres salidas cuando una corrección afecta inequívocamente a un solo alimento del catálogo: corregir ese alimento, guardar una variante o usar el cambio solo en esta comida. No atribuyas a un alimento concreto la diferencia de un carrito con varios alimentos.

## 14. Dar protagonismo global a la fibra

Audita antes de modificar: fibra ya existe en varios formularios y esquemas. El objetivo es paridad y visibilidad, no duplicación.

La fibra debe:

- Ser visible y editable en todo flujo que permita crear o editar comida: Modal Maestro, acceso rápido Comida, edición existente y adjunto de comida a glucosa/otros registros.
- Formar parte de las tarjetas del catálogo y del carrito.
- Aparecer por comida en la vista Nutrición.
- Sumarse durante el día y mostrarse como métrica de primera clase, no como una nota secundaria que solo aparece si es mayor que cero.
- Mantener la semántica “sin anotar” distinta de `0 g`.
- Conservar procedencia coherente si vino de IA, catálogo o edición manual.

No inventes una meta clínica de fibra si el producto/dominio no tiene una definición aprobada. Mostrar el total registrado y su completitud es obligatorio; cualquier objetivo nuevo necesita respaldo explícito en las reglas del producto.

---

## Experiencias que deben preservarse

- Los accesos rápidos son breves y de un solo propósito:
  - Comida → `MealModal`.
  - Corrección → `CorrectionModal`.
  - Basal → modal dedicado de Basal.
  - Cetonas → modal dedicado de Cetonas.
- Si los modales dedicados de Basal/Cetonas fueron eliminados, restaura componentes pequeños reutilizando validación y escritura compartidas; no copies lógica clínica.
- “Nueva entrada” conserva su Modal Maestro con seis secciones plegadas al abrir y precarga interna segura.
- El Timeline abre detalle de lectura antes de editar.
- El borrado conserva textos, confirmaciones y semántica por tipo salvo los ajustes estrictamente necesarios para la unificación comida/carbohidratos.
- Lecturas externas conservan origen y semántica.
- Las fórmulas de dosis del dominio no se reescriben.
- Deep links y aliases existentes siguen funcionando.
- No agregues una librería de navegación o dependencia grande si no es imprescindible.
- Los imports de iconos siguen la convención por subpath para no inflar Metro.

---

## Orden de implementación recomendado

Trabaja en capas para evitar una UI que prometa datos que todavía no persisten:

1. Caracterización y tests de regresión sobre el estado actual.
2. Modelo de datos/migraciones: promoción, imágenes de catálogo, timestamps y actualización merge de vitales.
3. Unificación de la representación comida + carbohidrato y deduplicación histórica.
4. Rutas de persistencia completas para crear comida desde una edición.
5. Reglas puras del Modal Maestro y enrutamiento desde Timeline.
6. Reutilización de herramientas maduras de comida y construcción del carrito.
7. Fecha/hora editable y cancelación/reprogramación de notificaciones.
8. Strip Calendar, carga por fecha y botón “+” contextual.
9. Catálogo/carrito visual y fibra global.
10. Restauración/verificación de accesos rápidos dedicados.
11. Revisión integral, documentación, verificación, commit y eliminación de este archivo.

Puedes ajustar el orden si el código demuestra otra dependencia, pero nunca abras primero campos que aún no pueden guardarse.

---

## Cobertura mínima obligatoria

Agrega tests unitarios/integración/UI en la infraestructura que ya tenga el repositorio. Como mínimo prueba:

### Modal y promoción

- El botón Editar enruta al maestro para cada tipo editable.
- Las secciones iniciales dependen del contenido, no del origen del botón.
- Promoción conserva id, timestamp, `created_at`, source y origin.
- Promover dos veces no crea dos grupos.
- Promover una comida no duplica episodio.
- Fallo intermedio no deja grupo a medias.

### Comida y carbohidratos

- Una comida con fila `meal_confirmed` aparece una sola vez.
- Un carbohidrato manual suelto sigue apareciendo.
- Datos históricos duplicados se leen una sola vez.
- Nutrición y reportes no cuentan dos veces.
- Editar la representación antigua de carbohidratos de comida llega a la comida real.
- Añadir comida a una glucosa persiste imagen, análisis, estimación, macros, calorías y procedencia.
- IA/catálogo/carrito no confirman carbohidratos sin acción explícita.

### Carrito y catálogo

- Dos o más líneas se acumulan sin reemplazo.
- Cambiar porción/gramos recalcula todos los totales.
- Quitar una línea recalcula el resto.
- Totales incompletos se etiquetan como mínimos.
- La migración conserva alimentos antiguos sin foto.
- La imagen se guarda/lee sin inventar una para datos antiguos.
- El contenedor de catálogo no edita; el lápiz sí.

### Calendario y tiempo

- Seleccionar un día cambia el rango diario consultado.
- Cambiar de mes mantiene una fecha válida.
- El “+” cambia de estado solo en una fecha pasada y se restaura al volver a hoy/salir.
- Nueva entrada hereda la fecha elegida y exige hora.
- No se puede guardar una fecha/hora futura.
- Volver del segundo plano no reemplaza una fecha histórica explícita con `now`.
- Mover hora actualiza columna y payload donde corresponda.
- `ingestedAt` no cambia.
- Episodio y espejo de carbohidratos se mueven/recalculan correctamente.
- Notificaciones antiguas se cancelan y no quedan duplicadas.

### Insulina, vitales y calculadora

- Editar una entrada no borra el nombre de insulina.
- Cambiar rápida ↔ basal usa el nombre correcto del perfil.
- Evento importado conserva su nombre.
- Corregir cetonas no toca peso/presión y viceversa.
- Campo no tocado no se pierde; blanco no se convierte en cero.
- La calculadora histórica muestra el título exacto y la advertencia.
- La calculadora usa carbohidratos confirmados, nunca estimados.
- Cambiar la base invalida el resultado previo.

### Fibra y accesos rápidos

- Fibra se persiste y aparece en cada flujo de comida.
- El total diario incluye fibra sin convertir ausencias en ceros confirmados.
- Catálogo y carrito renderizan fibra.
- Cada acceso rápido abre el modal dedicado correcto.
- Nueva entrada sigue abriendo el maestro.

Si un comportamiento de UI no es razonable de probar con la infraestructura actual, extrae su decisión a una función pura y pruébala allí. No uses snapshots ciegos como única evidencia.

---

## Verificación y revisión de regresiones

Antes de cerrar:

1. Lee el diff completo.
2. Ejecuta `pnpm verify` desde la raíz.
3. Ejecuta `git diff --check`.
4. Compara tests y módulos del bundle contra la línea base.
5. Haz una auditoría manual de estas preguntas:
   - ¿Algún campo visible carece de persistencia?
   - ¿Alguna estimación termina confirmada automáticamente?
   - ¿Una estimación alimenta la calculadora?
   - ¿Comida o carbohidratos aparecen/contabilizan dos veces?
   - ¿Se duplica algún episodio o notificación?
   - ¿Mover una hora deja una copia temporal atrás?
   - ¿Se modificó `ingestedAt` o la procedencia de una lectura externa?
   - ¿Se perdió el nombre histórico de una insulina?
   - ¿Un blank se convirtió en cero o borrado?
   - ¿Se degradó el editor avanzado de comida?
   - ¿Los accesos rápidos siguen siendo rápidos?
   - ¿La fecha histórica sobrevive a cámara/IA/background?
   - ¿Datos antiguos sin foto o sin grupo siguen siendo legibles?
6. Corrige cualquier regresión encontrada antes del commit.

No ocultes fallos ni arregles problemas previos no relacionados únicamente para obtener verde. Si encuentras un fallo previo, demuéstralo contra la línea base y repórtalo por separado.

---

## Documentación y Git

Actualiza en la misma corrida:

- `memory-bank/activeContext.md`: estado final y decisiones operativas; respeta su límite de tamaño.
- `memory-bank/progress.md`: trabajos cerrados, tests, bundle y nuevas reglas fallo → prevención.
- `memory-bank/codemap.md`: componentes, funciones, migraciones y archivos creados.
- `memory-bank/projectbrief.md`: corrige la regla antigua que solo daba herramientas potentes cuando la comida ya existía. Ahora también deben estar disponibles al **añadir** una comida desde la edición de una glucosa u otro registro.
- Contratos de seguridad/UX únicamente si la implementación establece una regla durable nueva.

Usa el estilo y convención de commits del repositorio. El cuerpo del commit debe explicar el porqué, las garantías de datos y las regresiones que evita. No incluyas identificadores de modelo.

---

## Autodestrucción controlada de esta directiva

Este archivo es temporal y no forma parte del producto final.

**No lo borres al comenzar.** Úsalo como checklist durante toda la implementación.

Solo después de que:

- los catorce cambios estén implementados;
- la documentación esté actualizada;
- `pnpm verify` y `git diff --check` hayan terminado;
- hayas revisado el diff completo;
- y estés listo para crear el commit final;

elimina exactamente el archivo:

`PROMPT_MAESTRO_14_CAMBIOS.md`

Incluye su eliminación en el mismo commit final, de modo que la rama terminada no conserve esta directiva. Verifica expresamente que ya no exista en el árbol de trabajo ni en el contenido final del commit.

Si una condición externa impide completar realmente el trabajo, **no finjas éxito ni borres este archivo**: conserva la directiva para la siguiente sesión y reporta el bloqueo concreto.

---

## Reporte final requerido

Después del commit, detente y entrega un reporte preciso con:

1. Commit base, rama creada y hash del commit final.
2. Los catorce cambios, cada uno con su resultado real.
3. Rutas de persistencia y migraciones nuevas.
4. Cómo se resolvió la promoción sin perder identidad ni duplicar episodios.
5. Cómo se unificaron comida y carbohidratos visibles sin doble conteo.
6. Cómo la edición de glucosa obtuvo foto, IA, catálogo y carrito.
7. Cómo funciona el carrito y qué exige confirmación explícita.
8. Cómo se mueve fecha/hora y qué timestamps nunca se mueven.
9. Cómo se cancelan/reprograman notificaciones.
10. Cómo se protege el nombre de insulina.
11. Cómo funciona Strip Calendar y el “+” contextual.
12. Qué cambió en Catálogo, imágenes y fibra.
13. Qué capacidades previas fueron preservadas, especialmente `MealEditModal`, accesos rápidos, fórmulas y lectura de sensor.
14. Archivos creados, modificados y eliminados, con motivo.
15. Resultado exacto de `pnpm verify`, `git diff --check`, cantidad de tests y módulos del bundle.
16. Confirmación explícita de que `PROMPT_MAESTRO_14_CAMBIOS.md` fue eliminado del commit final.
17. Riesgos concretos que sigan abiertos; no incluyas generalidades.

No hagas push ni abras PR.
