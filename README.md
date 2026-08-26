# Type 1A

Companion de diabetes tipo 1, Android-first y local-first. Conecta glucosa,
comidas, carbohidratos confirmados, registro de insulina y análisis descriptivo
post-comida — **manteniendo toda decisión de dosis fuera de la IA**.

> Software en desarrollo. No reemplaza las alarmas de FreeStyle Libre, ni la
> confirmación capilar cuando corresponde, ni el criterio de un equipo clínico.

## Correr en local

Requiere Node 24+, pnpm 11+ y un teléfono o emulador Android.

```bash
cp .env.example .env
cp apps/mobile/.env.example apps/mobile/.env.local
pnpm install
pnpm verify
pnpm dev:api
pnpm dev:mobile
```

Para un teléfono físico, `EXPO_PUBLIC_API_BASE_URL` apunta a la URL LAN del
backend (ej. `http://192.168.1.20:4100`).

El backend funciona **sin credenciales externas**: sin CGM cae a un proveedor
sintético visiblemente rotulado, sin clave de Abacus el análisis de comida cae a
registro manual, y sin internet el registro y el timeline local siguen andando.

## Dónde está la documentación

| Necesitas | Está en |
|---|---|
| las reglas de seguridad que gobiernan todo | [`AGENTS.md`](AGENTS.md) |
| el contexto del proyecto, el stack y la deuda | [`memory-bank/`](memory-bank/) — empieza por [`index.md`](memory-bank/index.md) |
| ubicar un archivo en el monorepo | [`memory-bank/codemap.md`](memory-bank/codemap.md) |
| las decisiones de arquitectura y su porqué | [`docs/adr/`](docs/adr/README.md) |
| conectar un sensor real | [`docs/CONECTAR_SENSOR.md`](docs/CONECTAR_SENSOR.md) |

⚠️ Antes de tocar builds o firma de Android, lee
[`memory-bank/techContext.md`](memory-bank/techContext.md) § Firma de Android:
regenerar el keystore borra el historial de quien ya tenga la app instalada.
