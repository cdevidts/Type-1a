# 0009 — El dictado se transcribe en el teléfono, y nunca envía solo

- **Estado:** Accepted
- **Fecha:** 2026-09-10
- **Reemplaza:** el plan de audio descrito en el ADR 0008, que mandaba el
  archivo al modelo. Ese camino no se implementó.

## Contexto

La Fase 4 del agente era el micrófono. El ADR 0008 dejó anotado el plan de
entonces —grabar con `expo-audio` y mandar el archivo a `gpt-audio-1.5` en dos
pasos— junto con lo que se había medido probando la API en vivo:

- `/v1/audio/transcriptions` no existe en RouteLLM (404).
- `gpt-audio-1.5` acepta `input_audio` **solo en wav o mp3**; **rechaza m4a**.
- audio y `json_schema` no se combinan en la misma llamada.

Al ir a construirlo apareció el bloqueo que el plan no había mirado: **Android
no sabe grabar en ninguno de los dos formatos que el modelo acepta.** Su
`MediaRecorder` produce m4a/AAC, 3GP, AMR, Opus o Vorbis, y ninguno más. Las
salidas eran transcodificar en el teléfono (ffmpeg: binario enorme, bindings de
React Native abandonados) o transcodificar en el backend (una dependencia nueva
sobre un servidor que ya cuesta redesplegar).

## Decisión

**El dictado usa el reconocedor de voz del sistema
(`expo-speech-recognition`), no un modelo remoto.** Y con dos reglas encima:

### 1. Se transcribe en el teléfono siempre que el teléfono pueda

`dictationRunsOnDevice` exige **dos** condiciones, y la segunda es la que se
olvida: que el aparato soporte reconocimiento local **y** que tenga el modelo
de español descargado. Un teléfono que soporta lo primero sin lo segundo falla
con `language-not-supported`, es decir, mudo y sin explicación.

Cuando no puede, se dicta igual con el reconocedor de red de Android **y la
pantalla lo dice mientras escucha**: "se transcribe en el teléfono" o "lo
transcribe el servicio de Android". No se presenta una cosa como la otra, que
es la regla que esta app aplica a los datos de sensor y que acá vale igual.

### 2. Las pistas de vocabulario no salen del teléfono

`dictationHints` le pasa al reconocedor los nombres de sus insulinas y de su
catálogo para que "Fiasp" no salga fonético. **Devuelve una lista vacía cuando
la transcripción no es local, y eso es la regla, no una limitación técnica:**
el nombre de una insulina revela que quien habla es diabético y con qué se
trata. Mandárselo a un servicio de dictado ajeno para mejorar el
reconocimiento sería exactamente la fuga que prohíbe el ADR 0007. Sin red se
dicta igual, solo que sin ayuda.

### 3. El micrófono es un teclado, no un botón de enviar

Lo dictado cae en el cuadro de texto y **se queda ahí** hasta que ella lo lea y
lo mande. El hook no conoce `send`: solo escribe. Un "doscientos sesenta"
entendido como "sesenta" tiene que ser un error visible y corregible, nunca una
glucosa falsa registrada sola — y de ahí para adelante siguen valiendo las
confirmaciones que ya existían: el borrador se muestra entero y no se escribe
nada hasta "Guardar".

## Consecuencias

**A favor:**

- El audio con su voz diciendo qué comió y en cuánto está **no sale del
  teléfono** cuando hay reconocimiento local. Bajo la Ley 21.719 una grabación
  de voz con contenido de salud es dato sensible, y además biométrico.
- Desaparece el problema de formato: ya no hay archivo que convertir.
- La transcripción no gasta llamadas al modelo, y aparece mientras habla
  (`interimResults`) en vez de después de subir un archivo.
- Funciona sin internet cuando el modelo local está instalado.

**En contra:**

- La calidad depende del reconocedor del aparato, no de un modelo que
  elijamos. Un modelo dedicado probablemente entendería mejor los nombres de
  comida chilenos. Se compensa en parte con `contextualStrings`.
- En un teléfono sin reconocimiento local el audio pasa por el servicio de
  Android. Se declara en pantalla y se le niegan las pistas, pero la
  alternativa era no tener micrófono en esos aparatos.
- Es un módulo nativo: **exige un build nuevo**, y hubo que sacar
  `RECORD_AUDIO` de `blockedPermissions` en `app.json`, donde estaba por
  higiene de la ficha de Play Store. Dejarlo habría eliminado el permiso en el
  build y el micrófono habría fallado sin ningún error visible.

## Qué se revisaría antes de cambiar esto

Si algún día se quiere calidad de transcripción por sobre localidad, la
pregunta no es técnica sino la del ADR 0007: si la voz de la usuaria hablando
de su salud puede salir del teléfono. Hoy la respuesta es no, y por eso el
dictado se resolvió sin mandar audio a ninguna parte.

## Addendum (2026-09-10, mismo día): se encendió la minificación

Este ADR cerró dejando abierto que `expo-speech-recognition` escribe la
transcripción **y las pistas de vocabulario** —las insulinas de la usuaria y su
catálogo— en el log del sistema con `Log.d`, sin condición. Se había decidido
no tocarlo por el riesgo de encender la minificación sin poder probarla.

Verónica pidió investigar si eso era ilegal o estaba prohibido por la tienda
antes de aceptarlo, y dijo que si lo era prefería "empezar con el pie derecho,
aunque quizás haya fallas". Lo era:

- **Android lo clasifica como vulnerabilidad**, categoría MASVS-STORAGE, con
  impacto de pérdida de confidencialidad — no como una recomendación de estilo.
  Y la mitigación que su documentación recomienda es exactamente R8 con
  `-assumenosideeffects`.
- **La evaluación de exposición que se había escrito era demasiado benigna.**
  Decía que el log es privado de la app desde Android 4.1 y que hacía falta un
  cable o un informe de error. Android advierte lo contrario: en muchos
  aparatos vienen aplicaciones **preinstaladas de fábrica** con `READ_LOGS`.
- **Play Store** nombra los datos de salud entre los "personal and sensitive
  user data" y obliga a manejarlos de forma segura.

Así que `enableProguardInReleaseBuilds` quedó en `true` con las reglas que
borran `Log.v/d/i` en release.

**El riesgo que motivó la duda sigue siendo real**, y se atiende de dos formas:

1. `verify:contracts` verifica que las dos mitades vayan juntas —
   `logStrippingIsWired()`. Reglas sin minificación no se ejecutan y *parecen*
   un arreglo; minificación sin reglas devuelve la transcripción al log. Las
   dos formas de romperlo están probadas.
2. `docs/PROBAR_UN_BUILD.md` es la lista que ella corre al instalar, ordenada
   de lo más frágil a lo menos, porque una compresión no rompe al abrir la app
   sino una pantalla suelta días después.
