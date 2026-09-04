# ADR 0007: La cuenta es para cobrar la suscripción, no para guardar datos de salud

status: Accepted (2026-09-04)

## Contexto

El 3 de septiembre se escribió un plan para sincronizar las quince tablas del
teléfono a Supabase, con cuentas, RLS y migración. Verónica lo aprobó y al día
siguiente lo revirtió, después de entender qué implicaba la **Ley 21.719**.

El razonamiento que la hizo cambiar de opinión es correcto y conviene dejarlo
escrito, porque es la clase de decisión que alguien va a querer reabrir:

- La ley entra en plena vigencia el **1 de diciembre de 2026**, clasifica los
  datos de salud como categoría de máxima protección, y obliga sin importar el
  tamaño de la organización.
- Guardar glucosa, insulina y comidas de terceros convierte este proyecto en
  responsable de datos sensibles: consentimiento expreso, medidas de seguridad,
  notificación de brecha en 72 h, derechos ARCOP, y multas de hasta 20.000 UTM.
- Ese costo se paga **para siempre y desde la primera usuaria**, a cambio de una
  comodidad —"cambiar de teléfono sin perder nada"— que se puede resolver de
  otra forma.

El plan quedó descartado y su archivo borrado. Vive en la historia de git, en el
commit `115913a` y anteriores, para quien necesite el análisis de costos o el
diseño del esquema.

## Decisión

**Tres reglas, y la primera manda sobre las otras dos.**

### 1. Ningún dato de salud sale del teléfono hacia una base nuestra

Glucosa, insulina, comidas, agua, actividad, vitales, HbA1c, recetas, perfil de
terapia y perfil de nutrición **viven solo en el dispositivo**. No hay tabla
nuestra que los reciba, y por lo tanto no hay nada que sincronizar, respaldar
del lado del servidor, ni notificar si el servidor se cae.

Esto **reafirma ADR 0001** en vez de revocarlo, que era lo que el plan borrado
proponía hacer.

Sigue en pie lo que ya se manda a servicios de IA para analizar una foto o un
episodio: eso es tránsito acotado y sin persistencia nuestra, y lo gobiernan
ADR 0002 y `AGENTS.md`. Lo que esta decisión prohíbe es **guardarlo**.

### 2. La cuenta existe para una sola cosa: cobrar

Correo, contraseña y estado de la suscripción. Nada más. Una cuenta no lleva
datos clínicos colgando, así que perder la contraseña no pone en riesgo ningún
dato de salud y recuperarla no obliga a que nadie pueda leerlos.

La app **sigue funcionando sin cuenta**. La cuenta se pide cuando se quiera
pagar, no al abrir.

### 3. El catálogo compartido sigue exactamente como está

**ADR 0003 no cambia.** Sigue siendo la única excepción de estado del backend, y
sigue siendo anónima por construcción: `SharedCatalogEntryInputSchema` no tiene
dónde poner un id de usuaria, una foto, una glucosa ni la hora de una comida.
"Arroz cocido tiene 28 g de carbohidratos por 100 g" no es un dato de salud de
nadie.

Lo que falta ahí es que la app móvil consuma los endpoints, que ya existen y ya
están desplegados. Eso no toca esta decisión.

## La portabilidad se resuelve con un archivo, no con un servidor

Lo que la sincronización iba a dar —cambiar de teléfono, no perder años de
registros— lo da un **archivo de respaldo que la usuaria controla**:

| Formato | Para qué | Quién lo lee |
|---|---|---|
| PDF | llevarle algo al médico | una persona |
| Excel | mirar los datos, hacer sus propios cálculos | una persona |
| `.t1a.json` | respaldar, cambiar de teléfono, migrar | **la app** |

El tercero es el que importa acá y es formato propio a propósito: tiene que
volver a entrar completo, sin pérdida y sin duplicar, cosa que un PDF o un
Excel bonito no garantizan. Se especifica en
`packages/domain/src/backup.ts` y se valida con Zod al importar, como todo
input externo.

Al no existir servidor, el archivo es también la respuesta a los derechos de
acceso y portabilidad si algún día hicieran falta: ya está construido y no
depende de nosotros.

## Consecuencias

- Se pierde la sincronización automática entre dispositivos. Es el precio
  elegido a sabiendas: respaldar es un acto explícito de la usuaria.
- Si pierde el teléfono sin haber exportado, pierde los datos. La app tiene que
  **empujar el respaldo**, no esconderlo en Ajustes; que sea fácil es lo que
  sostiene esta decisión.
- El backend no gana estado nuevo. La única tabla sigue siendo `food_catalog`.
- Cobrar una suscripción sigue necesitando cuentas, y las cuentas siguen
  necesitando una política de privacidad — pero sobre correo y facturación, que
  es un problema ordinario y no uno de datos sensibles.
