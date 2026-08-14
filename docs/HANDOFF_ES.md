# Type 1A 0.1 — entrega del MVP

## Estado

El repositorio contiene un MVP Android-first, local-first y compatible a nivel de bundle con iOS. Funciona sin credenciales externas para registrar datos manuales y usa CGM sintético, siempre rotulado, durante desarrollo.

No se generó un APK firmado porque este entorno no tiene Android SDK, cuenta Expo ni credenciales de firma. `eas.json` deja preparado un perfil `preview` que genera APK cuando se autentique EAS.

## Flujos implementados

- glucosa actual, tendencia, hora de fuente, antigüedad y gráfico de tres horas;
- registro rápido de carbohidratos, insulina rápida e insulina basal;
- calculadora experimental de corrección con parámetros del usuario, redondeo determinístico, bloqueo de CGM atrasado y contexto de rápida reciente sin IOB;
- foto de comida, compresión local, análisis multimodal por Abacus RouteLLM, macros e incertidumbre;
- ingreso manual si cámara, red o IA fallan;
- separación visible entre carbohidratos estimados y confirmados;
- timeline local y Meal Episodes con métricas +60/+120/+180, pico, mínimo, delta y tiempo a pico;
- confirmación explícita de la asociación comida–insulina si hay cero o múltiples candidatas;
- insight descriptivo opcional con filtro que rechaza recomendaciones terapéuticas;
- notificaciones locales, deep links y tres acciones Android de pantalla bloqueada;
- SQLite con SQLCipher en builds nativos y clave aleatoria guardada en SecureStore;
- backend sin secretos en el bundle móvil.

## Ruta FreeStyle seleccionada

1. `freestyle_libre` de Junction en región EU mediante una práctica LibreView es la ruta de producción.
2. Mock determinístico o FreeStyle sintético de Junction es la ruta de validación.
3. Exportación CSV de LibreView queda como fallback histórico; el parser y sus pruebas están incluidos.
4. LibreLinkUp no se usa porque no se identificó una API pública general para esta integración.
5. Libre Data Share no se usa como runtime porque el acceso descrito por la app es temporal y orientado a equipos clínicos.

## Puesta en marcha

```bash
cp .env.example .env
cp apps/mobile/.env.example apps/mobile/.env.local
pnpm install
pnpm verify
pnpm dev:api
pnpm dev:mobile
```

Para un teléfono físico, `EXPO_PUBLIC_API_BASE_URL` debe apuntar a la IP LAN del computador. Para conectar servicios reales hay que completar en `.env`:

- `JUNCTION_API_KEY`, `JUNCTION_USER_ID` y `CGM_PROVIDER=junction`;
- `ABACUS_ROUTE_LLM_API_KEY`.

## Validación realizada

- lint: aprobado;
- TypeScript estricto: aprobado en seis paquetes;
- pruebas: 23 aprobadas;
- bundle Expo Android: aprobado, 920 módulos;
- bundle Expo iOS: aprobado, 920 módulos;
- configuración Expo y plugins nativos: validada con SDK 57.

## Gate siguiente

El siguiente paso útil es una prueba cerrada con el único tester: conectar Junction sandbox, confirmar timestamps en `America/Santiago`, activar Abacus con una clave de backend, producir el APK `preview` con EAS y ejecutar la matriz de seguridad en un Android real.
