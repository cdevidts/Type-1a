# Conectar tu sensor FreeStyle Libre a Type 1A

Guía para cualquier persona que instale Type 1A y quiera ver su propia
glucosa en la app.

**Tiempo estimado:** 10 minutos, casi todo esperando la invitación.

---

## Antes de empezar: qué necesitas

1. Un sensor **FreeStyle Libre** activo (Libre 2 o Libre 3).
2. La app oficial con la que escaneas o lees tu sensor — **LibreLink** — ya
   funcionando en tu teléfono, con tu cuenta.
3. Conexión a internet.

> **Lo más importante y lo que más confunde:** Type 1A **no** usa tu cuenta de
> LibreLink (con la que escaneas). Usa **LibreLinkUp**, que es la app de
> *seguimiento* de Abbott — la que normalmente instala un familiar para ver tu
> glucosa a distancia. Son dos apps y dos cuentas distintas.
>
> Vas a crear una cuenta de LibreLinkUp y **seguirte a ti misma**. Suena raro,
> pero es exactamente cómo funcionan casi todas las apps de terceros que leen
> el Libre: Abbott no publica una API para leer tu propio sensor directamente.

---

## Paso 1 — Activa el uso compartido en LibreLink

En la app **LibreLink** (la que ya usas):

1. Abre el menú (☰) → **Compartir** o **Conexiones**.
2. Busca **LibreLinkUp** y actívalo.
3. Te va a pedir el **correo de la persona que te va a seguir**. Escribe el
   correo que vas a usar para tu cuenta de LibreLinkUp. Puede ser el mismo
   correo tuyo de siempre — no tiene que ser de otra persona.
4. Envía la invitación.

## Paso 2 — Crea tu cuenta de LibreLinkUp

1. Instala **LibreLinkUp** desde Google Play o la App Store (es una app
   distinta de LibreLink).
2. Regístrate con **el mismo correo** al que enviaste la invitación en el
   paso 1.
3. Confirma el correo si Abbott te lo pide.

## Paso 3 — Acepta la invitación

1. Abre **LibreLinkUp**.
2. Debería aparecerte una invitación pendiente para seguir tu sensor.
   Acéptala.
3. **Verifica que funcione ahí primero**: si LibreLinkUp te muestra tu
   glucosa, estás lista. Si LibreLinkUp no la muestra, Type 1A tampoco va a
   poder — el problema está en este paso, no en Type 1A.

> La invitación puede tardar unos minutos en llegar. Si no aparece, revisa la
> carpeta de spam del correo y que el correo escrito en el paso 1 no tenga
> una errata.

## Paso 4 — Conecta Type 1A

En Type 1A:

1. Toca el botón de **Ajustes** (arriba a la derecha).
2. Pestaña **Dispositivos** → sección **Conectar tu sensor**.
3. Escribe el **correo y la contraseña de tu cuenta de LibreLinkUp** (la del
   paso 2 — no los de LibreLink).
4. Elige tu **región**. Chile y el resto de Latinoamérica usan
   **Latinoamérica**. Si eliges la equivocada, la app igual intenta corregirlo
   sola, pero es más rápido acertar.
5. Toca **Conectar mi sensor**.

La app prueba la conexión antes de guardar nada. Si el mensaje dice que quedó
conectado, listo: tu glucosa empieza a aparecer en la pantalla principal.

---

## Si algo falla

| Mensaje | Qué significa y qué hacer |
|---|---|
| "LibreLinkUp rechazó ese correo o contraseña" | Estás usando los datos de **LibreLink** en vez de los de **LibreLinkUp**. Son cuentas distintas. Si estás segura de que son los de LibreLinkUp, entra a la app LibreLinkUp con ellos para confirmar. |
| "La cuenta existe, pero no está siguiendo ningún sensor" | La cuenta se creó bien, pero falta el paso 3: la invitación no se envió, no llegó, o no se aceptó. Revisa en LibreLinkUp que veas tu glucosa ahí. |
| "No se pudo contactar a LibreLinkUp" | Problema de internet, o Abbott caído. Vuelve a intentar más tarde. |
| Conecta, pero la glucosa aparece "ATRASADA" | Normal si tu teléfono no ha estado cerca del sensor. LibreLinkUp solo tiene los datos que la app LibreLink haya subido. Abre LibreLink, escanea el sensor y vuelve a Type 1A. |

**Mientras el sensor no funcione, la app sigue sirviendo.** Puedes registrar
glucosa a mano, carbohidratos, insulina y comidas sin ninguna conexión. Eso es
a propósito.

---

## Qué pasa con tu contraseña

Tu contraseña de LibreLinkUp se guarda **cifrada en tu propio teléfono**
(Keystore de Android, vía `expo-secure-store`) y viaja **solo** entre tu
teléfono y los servidores de Abbott. **No pasa por los servidores de
Type 1A** y no la guardamos en ningún lado.

Puedes borrarla cuando quieras con **Desconectar este sensor**. Eso no borra
tu historial: solo deja de leer lecturas nuevas.

---

## Notas para quien mantiene el código

- La ruta del dispositivo vive en `apps/mobile/src/sensorConnection.ts` y usa
  el **mismo** `LibreLinkUpCGMProvider` de `packages/cgm` que corre en el
  backend, para no mantener dos implementaciones de una API de ingeniería
  inversa. La única diferencia es `sha256Hex`, inyectado
  (`node:crypto` en el servidor, `expo-crypto` en el teléfono).
- **Si no hay credenciales guardadas, la app usa el backend exactamente como
  antes.** Esa es la ruta que sigue usando la instalación original de
  Verónica, con las variables `LIBRELINKUP_EMAIL`/`LIBRELINKUP_PASSWORD` del
  entorno de Abacus. Por eso este cambio **no requiere redeploy** y no puede
  romper su conexión.
- Si la ruta del dispositivo falla, **no** se cae de vuelta al backend, a
  propósito: eso mostraría el sensor de otra persona (el de la credencial
  global del servidor) presentado como propio.
- LibreLinkUp es una API **no oficial**. Puede romperse sin aviso. Todo fallo
  degrada a registro manual, como exige `AGENTS.md`.
- El botón viejo "Iniciar conexión LibreView" apuntaba a
  `/v1/provider/junction/link` (Junction/Vital), que **no** es el proveedor en
  uso: no cambiaba de dónde salían los datos. Se eliminó. Ver
  `docs/CGM_INTEGRATION_DECISION.md` para por qué el plan original era Junction
  y qué se terminó usando.
