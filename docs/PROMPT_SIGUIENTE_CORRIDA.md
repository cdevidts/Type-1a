# Prompt para la corrida siguiente — Fase 19

Copiar y pegar **todo lo que está dentro del bloque**. Está escrito para que la
corrida no gaste tokens re-explorando: las decisiones ya están tomadas y los
archivos y constantes ya están localizados.

> **Hábito permanente (pedido de Verónica, 2026-08-20):** este archivo se
> reescribe **al cierre de cada corrida**, apuntando a la corrida siguiente.
> Es el punto 6 del checklist de `CLAUDE.md § Cierre de corrida`. Una corrida
> que termina sin dejar este prompt apuntando a lo próximo no está cerrada.

---

```
Fase 19 del roadmap: notificaciones distinguibles entre sí. A diferencia de
las Fases 16-18, esta SÍ toca configuración nativa y necesita su propio build.

Lee primero docs/ROADMAP_V0.2.md § "Fase 19" — la investigación ya está hecha
y la decisión ya está tomada, NO la re-derives. Invoca /iconography (disparo
automático: tocas cómo se ve una notificación).

POR QUÉ IMPORTA: es seguridad, no estética. Con las tres alarmas
(post-comida, corrección, capilar) llegando iguales, se vuelven
indistinguibles y se ignoran todas — incluidas las que importan. Fatiga de
alarma.

LA DECISIÓN, YA TOMADA: se combinan las CUATRO capas, porque cada una opera
en un plano distinto y ninguna sola resuelve el problema.
  1. Emoji al inicio del título       → distinguir de un vistazo, sin leer
  2. `content.color` por tipo         → Android tiñe icono y nombre de la app
  3. Título explícito por tipo        → saber qué es sin abrir
  4. UN CANAL DE ANDROID POR TIPO     → distinguir SIN MIRAR, y —clave— poder
                                        silenciar un tipo sin perder los otros
                                        desde los ajustes del sistema
LO QUE NO SE HACE: un icono pequeño distinto por tipo. Verificado contra
expo-notifications@57 en node_modules: `NotificationContentAndroid` expone
solo `badge`, `color`, `priority`, `vibrationPattern` — no hay `smallIcon`, y
el config plugin compila UN icono a `@drawable/notification_icon`. Cambiarlo
exige un config plugin propio con varios drawables y `setSmallIcon` por
notificación. No lo justifica.

TRAMPAS YA VERIFICADAS EN EL CÓDIGO (no las re-investigues):

1. ANDROID CONGELA EL CANAL AL CREARLO. El sonido y la vibración de un canal
   son inmutables después de la primera creación, y los canales actuales YA
   EXISTEN en el teléfono de Verónica desde instalaciones anteriores. Cambiar
   sus propiedades en código NO HACE NADA. Un canal con sonido distinto
   necesita un **id nuevo**. Ojo con dejar huérfanos los viejos: quedan
   visibles en los ajustes de Android confundiendo a la usuaria; hay que
   borrarlos con `deleteNotificationChannelAsync`.

2. CON LA APP ABIERTA NO SUENA, Y ES UN BUG. `setNotificationHandler` en
   apps/mobile/src/notifications.ts devuelve `shouldPlaySound: false`, que
   gobierna la presentación en primer plano. Si Verónica probó las alarmas
   con la app abierta escuchó silencio aunque hubiera elegido "sonido".
   Arréglalo: el estilo elegido (`ReminderAlertStyle` en src/types.ts) tiene
   que respetarse también en primer plano.

3. La notificación pegajosa de registro rápido tiene su propio canal
   silencioso y **nunca** debe sonar: se repone cada ~15 min.

CIERRE OBLIGATORIO (CLAUDE.md § Cierre de corrida):
- pnpm verify en verde.
- npx expo export:embed --eager --platform android --dev false desde
  apps/mobile, ANTES de gastar build. Metro NO reescribe .js→.ts en imports
  relativos: tsc y vitest pasan y el build muere. Ya pasó dos veces.
- Iconos SIEMPRE por subpath (Metro no hace tree-shaking; medido 1.263 →
  3.088 módulos por el barrel, 1.325 hoy por subpath). Kebab-case.
    import Plus from 'lucide-react-native/icons/plus';   // ✅
- domain-safety-reviewer: el texto de una alarma es superficie de seguridad
  (habla de dosis y de corrección). OJO: el subagente puede fallar por límite
  de gasto de la cuenta; si pasa, corre /safety-audit tú mismo y DILO
  explícitamente al entregar, no lo des por hecho.
- docs/CODE_MAP.md y docs/AI_CHAT_ARCHITECTURE.md (§3: programar alarmas ya
  está listado; actualiza la nota si cambia la forma).
- docs/DEEPAGENT_REDEPLOY_PROMPT.md: si no tocas apps/api, anótalo en la tabla.
  El redeploy de la Fase 17 SIGUE PENDIENTE (lo comparten la 17 y la 18).
- docs/ROADMAP_V0.2.md: marca la Fase 19 completada.
- Reescribe docs/PROMPT_SIGUIENTE_CORRIDA.md apuntando a la Fase 20.
- Commit + push a claude/revision-build-prep-b6p20n.

Y AVISA AL ENTREGAR: una notificación no se puede dar por verificada sin
probarla en el teléfono, igual que un gesto. Di qué quedó sin probar.

Reporta los cambios y espera aprobación antes del build.
```

---

## Por qué la Fase 19 y no la 20

- **Las dos necesitan build propio**, así que ya no hay ruta "sin build" que
  optimizar; se ordenan por valor.
- **La 19 es seguridad**, la 20 es comodidad. Una alarma que se ignora por
  fatiga es un riesgo clínico; un widget que falta es una molestia.
- La 20 (widget 4×3) además arrastra una dependencia nueva con config plugin
  (`react-native-android-widget` o `expo-widgets`), que conviene evaluar sin
  apuro.

## Estado de la ruta

| Fase | Alcance | ¿Build? | ¿Redeploy? |
|---|---|---|---|
| ~~16~~ | ~~Barra inferior, swipe, iconos, marcas de hora~~ | Hecho (`98acb218`) | No |
| ~~17~~ | ~~Editar comida con IA~~ | Sin build aún | **Sí, pendiente** |
| ~~18~~ | ~~Catálogo editable, porciones, pregunta de 3 salidas~~ | Sin build aún | No (comparte el de la 17) |
| **19** | Notificaciones distinguibles | **Sí, propio** | No |
| 20 | Widget 4×3 de pantalla de inicio | **Sí, propio** | No |

## Deuda conocida, para no re-descubrirla

- **Ítem 10b**: mostrar glucosa en mmol/L en toda la app. Bloqueado hasta que
  `TherapyProfile` guarde la unidad como parte del modelo de datos.
- **Catálogo compartido entre usuarias**: ya **construido** (2026-08-21,
  `apps/api/src/food-catalog-store.ts`, `docs/adr/0003-shared-food-catalog.md`).
  Falta el redeploy (ver `DEEPAGENT_REDEPLOY_PROMPT.md`, prompt consolidado
  con la Fase 17) y, después, la fase de `apps/mobile` que lo consuma —
  todavía sin número de fase asignado en el roadmap.
- **Quitar `LIBRELINKUP_EMAIL`/`PASSWORD`** del entorno de Abacus cuando
  Verónica confirme que su cuenta quedó conectada desde la app. Va como
  addendum opcional del mismo prompt consolidado, no en el cuerpo principal.
- **Nada de gestos ni notificaciones se puede dar por verificado sin
  dispositivo.** El swipe de la Fase 16 pasó una corrida entera roto porque
  `pnpm verify` no dice nada al respecto.
- **2026-08-21**: si esta corrida terminó sin disparar el redeploy
  consolidado, `apps/api` sigue un paso atrás de lo que hay en el repo — dos
  cosas nuevas sin desplegar: el modo de edición por instrucción (Fase 17) y
  el catálogo compartido. No es bloqueante para nada de lo que ya funciona.
