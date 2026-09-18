# ADR 0008: El agente usa salida estructurada, no un bucle de tool calling

status: Accepted (2026-09-10)

## Contexto

El chat de IA lleva desde el MVP como "pendiente, sin construir". La duda
bloqueante estaba escrita en `reference/ai-chat-capabilities.md`: *"Confirmar
soporte de `tools`/function-calling en la API de RouteLLM — bloqueante antes de
escribir el bucle de tool use."*

Se probó contra la API real, con la clave de producción, en vez de suponer:

| Prueba | Resultado |
|---|---|
| `/v1/audio/transcriptions` | 404, no existe |
| `gpt-audio-1.5` con `input_audio` | ✅ describió el tono de prueba con precisión |
| `gpt-audio-mini` con `input_audio` | ❌ responde "no hay audio adjunto" pese a estar en el catálogo |
| Formato `m4a` | ❌ *"Supported values are: 'wav' and 'mp3'"* |
| Audio + `response_format: json_schema` | ❌ *"not supported with this model"* |

Y sobre `tools`, hay un defecto documentado y reproducido por terceros
([openclaw#6661](https://github.com/openclaw/openclaw/issues/6661)): RouteLLM
devuelve las llamadas a herramienta **como texto plano**, sin objetos
`tool_call`, y rechaza `strict` dentro de una definición de herramienta.

## Decisión

**El agente no usa un bucle de tool calling. El modelo devuelve un objeto
estructurado por turno, validado con Zod, y la app ejecuta.**

El motivo no es preferencia de estilo. En una app de salud, una llamada a
herramienta que degrada silenciosamente a prosa significa que el modelo dice
"listo, registré tu comida" y **no se escribió nada**. La alternativa
—`response_format: json_schema` con `strict: true`— ya está en producción en
este repo desde el análisis de comida, y sobrevivió al incidente de
`exclusiveMinimum`, o sea que funciona contra **los dos modelos distintos** a
los que RouteLLM enruta según el tamaño del payload. Está probada en el peor
caso conocido.

Tres consecuencias que se derivan de ahí:

1. **Un turno = una llamada.** Sin bucle no hay multiplicación por N, y el
   registro completo sale de una sola vez en vez de cinco preguntas seguidas.
   La queja de UX de Verónica y el costo en créditos tenían la misma causa.
2. **El borrador que produce el modelo es del mismo tipo que el payload del
   Modal Maestro.** No "parecido": el mismo. Así es estructuralmente imposible
   que el agente sea más pobre que el formulario, que es la regla inquebrantable
   de `projectbrief.md`, ahora aplicada al agente.
3. **El audio va en dos pasos**, porque audio y `json_schema` no se combinan:
   voz → texto con `gpt-audio-1.5`, y el texto entra al turno estructurado. Sale
   mejor de lo que se buscaba: la transcripción **se ve y se corrige** antes de
   que exista un borrador, así que una palabra mal oída no se convierte en
   silencio en un conteo de carbohidratos equivocado.

## El registro de capacidades es código, y `verify` lo hace cumplir

`packages/domain/src/agent-tools.ts` declara qué alcanza el agente y qué no,
**con el motivo escrito** en cada exclusión. `pnpm verify:contracts` falla si
una función exportada de `db.ts` no está en ninguna de las dos listas.

Es la respuesta al pedido de que "cada avance de la app sea también un avance
del agente": no una promesa en un documento, un build roto. El mecanismo ya
tiene precedente — el mismo chequeo existe porque una purga de documentación
dejó ciegos a cinco de siete activos sin producir un solo error. En su primera
corrida el candado ya encontró una capacidad sin clasificar.

El catálogo salió de la prosa por una razón concreta: en
`reference/ai-chat-capabilities.md` llevaba 123 de sus 150 líneas de techo, y un
catálogo que crece cada corrida dentro de un archivo con tope termina "resumido"
por alguien que borra justo lo que importaba. El documento se queda con el
porqué —las capacidades peligrosas, la frontera, los rechazos—, que es lo que
una tabla no explica.

## Consecuencias

- Si RouteLLM arregla `tools`, esta decisión se puede revisar. No hay que
  volver: un turno estructurado es más barato y más fácil de validar igual.
- `response_format` con `json_schema` **no está documentado** por Abacus, aunque
  funcione. Es una dependencia de comportamiento observado, no de contrato: si
  un día deja de responder, el síntoma será `invalid_output` y hay que probar
  contra la API antes de culpar al código.
- El audio suma `expo-audio` y el permiso `RECORD_AUDIO`, que **exige un build
  nuevo**: no entra por actualización de JavaScript.
