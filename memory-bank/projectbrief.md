# Project Brief — Type 1A

## Qué es

App **Android-first** de acompañamiento para **diabetes tipo 1**. Registra
glucosa, comidas, carbohidratos confirmados, insulina y actividad, y describe
lo que ya pasó para conversarlo con el equipo clínico.

Usuaria principal: Verónica. Es una app de salud en uso real, no un prototipo.

## Arquitectura de datos: local-first con auxiliar remoto

| Capa | Tecnología | Rol |
|---|---|---|
| **Fuente de verdad** | `expo-sqlite`, 12 tablas, en el dispositivo | Timeline completo: glucosa, comidas, insulina, notas, vitales, episodios |
| **Auxiliar remoto** | PostgreSQL vía `apps/api` | **Solo** el catálogo de alimentos anónimo y compartido |
| **Backend** | Fastify (`apps/api`) | Normaliza CGM, orquesta IA, expone HTTP. **Sin estado del paciente.** |

El timeline **nunca** se sube a un servidor. Las lecturas de CGM se consultan a
través del backend porque ahí viven los secretos, no porque el backend guarde
el historial.

## Lo que la app hace y lo que deliberadamente no hace

**Hace:** registra, agrega, describe patrones observados, exporta reportes
PDF/Excel para el control médico, y aplica **aritmética de dosis con los
parámetros que la usuaria cargó** (`calculateCorrection`, `calculateMealBolus`).

**No hace, y no puede hacer nunca:**

- Decidir o sugerir una dosis por su cuenta.
- Inferir parámetros de terapia (objetivo, factor de corrección, incremento,
  ratio de carbohidratos). Son valores que ingresa la usuaria.
- Calcular insulina activa (IOB) ni dosificación automática.
- Presentar datos sintéticos, importados, manuales o atrasados como lectura de
  sensor en vivo.
- Mezclar carbohidratos estimados por IA con los confirmados por la usuaria.

Ante fallo de IA o de CGM, **degrada a registro manual** y lo dice.

## Integración CGM

`CGMProvider` es la interfaz. El proveedor **real en producción es
LibreLinkUp** (`packages/cgm/src/librelinkup.ts`, instanciado en
`apps/api/src/app.ts`). Junction quedó como camino alternativo/fallback; hay
documentación histórica que lo describe como la ruta principal y **está
desactualizada**. Otros providers: `libreview-csv` (importación), `mock`.

## Arquitectura del Modal Maestro (regla inquebrantable)

Decisión de producto de los fundadores. **No se negocia por corrida.**

- **Los accesos rápidos individuales se quedan.** Están bien como están: son la
  vía de registro en pocos toques y no se tocan para "unificar".
- **"Nueva entrada" y TODOS los modales de edición consumen un mismo componente
  maestro** que agrupa toda la potencia de los accesos rápidos. Un flujo de
  edición nunca puede ser más pobre que uno de creación — ya pasó, y costó una
  fase entera.
- **La edición es retroactiva y sin límite de tipo.** Editar una glucosa
  aislada tiene que permitir agregarle una comida después. El tipo con el que
  se creó un evento no restringe lo que se le puede sumar más tarde.
- **Las herramientas potentes aparecen por contenido, y están siempre
  disponibles.** Si el evento ya tiene comida, el modal hospeda su editor con
  IA; si **no** la tiene, la sección de comida ofrece igual foto, IA, catálogo
  y carrito para **añadirla**. La regla vieja —"si no tiene comida, no se
  ofrece"— era el hueco central: editar una glucosa de anteayer solo daba un
  formulario básico, así que agregarle lo que se comió obligaba a rehacer el
  registro. Lo que decide el contenido es **qué sección arranca abierta**, no
  qué se puede agregar.
- **Antes de agregar una capacidad a un modal, se audita dónde más vive.** El
  Modal Maestro se construye consolidando lo mejor de los cuatro formularios
  actuales, no escribiendo un quinto.

Lo que sostiene esa arquitectura hoy: `UnifiedEntryModal` como componente
único de creación y edición, `masterModal.ts` con sus reglas puras y con test,
`MacroFields.tsx` y `MealCart.tsx` compartidos por los tres flujos de comida, y
`resolveMacrosSource` en `packages/domain` como única voz sobre la procedencia.

## Estado del producto

MVP entregado y en uso. El trabajo en curso es post-MVP: rediseño de UX,
importación de historial, reportes, y un chat de IA aún no construido.
