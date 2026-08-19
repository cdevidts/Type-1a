# Prompt de redeploy — backend de producción (Abacus / DeepAgent)

Este documento existe para **no gastar créditos de Abacus en un redeploy
hasta que sea realmente necesario**. Pedido explícito de Verónica
(2026-08-18): preparar el prompt de antemano, no dispararlo ahora.

## Registro de corridas que NO requirieron redeploy

Se anota acá para que una corrida futura no tenga que re-derivar si el
backend quedó atrás. Si tu cambio no tocó `apps/api`, agrégate a esta lista
en vez de abrir la pregunta de nuevo.

| Fecha | Corrida | Backend tocado |
|---|---|---|
| 2026-08-19 | Fase 9 reforzada: gráficos diarios en el reporte + Fase 11 (TIR, HbA1c estimada) | No — solo `packages/domain` y `apps/mobile`. |
| 2026-08-19 | Pantalla "Resumen" (AGP, métricas, patrones por franja) y su integración a los reportes | No — solo `packages/domain` y `apps/mobile`. Todo el cálculo es local por diseño (`docs/adr/0001-local-first.md`). |
| 2026-08-19 | Migración del proyecto EAS a la cuenta `cris-devit` (misma llave de firma) | No — solo `apps/mobile/app.json`/`eas.json` y credenciales locales fuera de git. |
| 2026-08-19 | Registro de bugs de interfaz del Resumen encontrados en dispositivo (Fase 13, solo documentación) | No — solo `docs/ROADMAP_V0.2.md`. |
| 2026-08-19 | Fase 13 Grupo A: bug de unidades mg/dL↔mmol/L (`meal.ts`, `GlucoseCard`, `GlucoseChart`, `CorrectionModal`, `EntryModal`, `notifications.ts`, `db.ts`) + fixes de layout del Resumen | 🟡 Matizado, no un "no" limpio. `apps/api` en sí no se tocó, pero sí `packages/ai/src/prompts.ts` (`glucoseInsightSystemPrompt`), que `apps/api/src/app.ts` importa y usa en cada llamada al insight post-comida — el backend YA desplegado sigue corriendo con el prompt viejo hasta que se redespliegue. La parte peligrosa del bug (el valor crudo entrando a la calculadora de dosis) era 100% cliente y ya queda resuelta con solo instalar el APK nuevo — la app ahora manda al backend los números de `MealEpisodeMetrics` ya en mg/dL, redeploy o no. Lo único que sigue atrasado en producción es que el modelo puede seguir sin la instrucción explícita de decir "mg/dL" en el texto que genera — riesgo bajo (número correcto, posible palabra de unidad equivocada en la prosa), no bloqueante. Redeploy real solo si se confirma que el texto generado sigue mencionando mmol/L después de que Verónica actualice la app. |

## Cuándo usarlo

Solo cuando algo que ya está arreglado en este repo (`apps/api`) siga
fallando en producción porque el servidor desplegado está desactualizado.
Antes de disparar el redeploy, confirmar que es genuinamente ese caso y no
otra cosa:

1. Reproducir el fallo contra el servidor real (no contra `apps/api` local)
   con un `curl` directo. Ejemplo ya documentado en
   [`ROADMAP_V0.2.md`](ROADMAP_V0.2.md) (§ "No-bug encontrado en
   dispositivo... backend desplegado desactualizado"):
   ```bash
   curl -X POST https://237e8b7f1.abacusai.cloud/v1/ai/meal-analysis \
     -H 'Content-Type: application/json' \
     -d '{"description":"una manzana"}'
   ```
2. Comparar el código/mensaje de error de la respuesta contra
   `apps/api/src/app.ts` en este repo (rama actual). Si el código de error o
   el schema que rechaza la request **no existen** en el `app.ts` de hoy,
   el servidor desplegado predata el cambio — eso es la señal real de que
   hace falta redeploy, no una suposición.
3. Confirmar que `pnpm verify` pasa en verde en este repo antes de pedir el
   redeploy — nunca desplegar código que no pasa su propia verificación.

Si el fallo resulta ser otra cosa (bug real de código, error del cliente,
CGM/Junction caído, etc.), **no** dispares este prompt — arregla el código
acá y commitea, o diagnostica el problema real primero.

## El prompt (copiar/pegar a DeepAgent tal cual, completando el resumen)

```
Necesito que redespliegues el backend de Type 1A (apps/api de
github.com/cdevidts/type-1a) a producción, en el host que ya está
sirviendo https://237e8b7f1.abacusai.cloud.

Contexto: el código de apps/api en la rama <RAMA> ya tiene el fix/cambio
para <RESUMEN DEL CAMBIO — completar antes de enviar>, pero el servidor
desplegado sigue corriendo una versión anterior. Verificado con:

<PEGAR AQUÍ EL CURL Y LA RESPUESTA QUE PRUEBA QUE ESTÁ DESACTUALIZADO>

Por favor:
1. Redespliega apps/api desde la rama <RAMA> (commit <SHA> si lo tienes) al
   mismo host que ya sirve producción — no cambies el dominio ni la URL que
   usa la app móvil (apps/mobile apunta a EXPO_PUBLIC_API_BASE_URL, que ya
   está configurada contra ese host).
2. No hace falta ninguna credencial nueva: apps/api sigue leyendo las mismas
   variables de entorno de siempre (ABACUS_API_KEY, JUNCTION_*, etc. — ver
   apps/api/src/config.ts y .env.example en el repo). No las hardcodees ni
   las cambies.
3. Después del deploy, confirma con el mismo curl de arriba que la respuesta
   cambió (código de error nuevo, o 200 si el caso ya no debería fallar).

Este backend no persiste datos de usuario (es un proxy sin estado hacia
CGM/Abacus RouteLLM — ver docs/adr/0001-local-first.md del repo), así que
un redeploy no tiene riesgo de pérdida de datos ni de downtime con estado.
```

## Nota de costo

Verónica pidió explícitamente no disparar esto salvo que sea crítico —
cada redeploy vía DeepAgent consume créditos de Abacus. Si el problema puede
esperar a acumularse con otros cambios pendientes de backend, prefiere
agrupar varios fixes de `apps/api` en un solo redeploy en vez de disparar
este prompt cada vez que se cierra un bug individual.
