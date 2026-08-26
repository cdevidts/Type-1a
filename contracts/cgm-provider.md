# Contrato — proveedores de CGM

> **Capa 1 · consumido por** `/new-cgm-provider`
> Sustituye la narrativa histórica de `docs/CGM_INTEGRATION_DECISION.md`.
> La decisión formal y su contexto están en `docs/adr/0004-cgm-provider-librelinkup.md`.

## Estado real de la ruta de datos

**El proveedor en producción es LibreLinkUp.** `LibreLinkUpCGMProvider` es el
que instancia `apps/api/src/app.ts`. Junction quedó implementado
(`JunctionCGMProvider`, `JunctionLinkService`) pero **fuera de la ruta de
datos**, como alternativa.

Cualquier documento que describa Junction como la ruta principal está
desactualizado. Es el error que hizo que varias corridas asumieran la
arquitectura equivocada.

| Provider | Archivo | Estado |
|---|---|---|
| `LibreLinkUpCGMProvider` | `packages/cgm/src/librelinkup.ts` | **producción** |
| `JunctionCGMProvider` | `packages/cgm/src/junction.ts` | alternativa, sin uso |
| `LibreViewCsvProvider` | `packages/cgm/src/libreview-csv.ts` | importación de historial |
| `MockCGMProvider` | `packages/cgm/src/mock.ts` | desarrollo, datos sintéticos |

## Reglas para un provider nuevo

- [ ] Implementa la interfaz `CGMProvider` de `packages/cgm/src/provider.ts`.
      No se agrega un camino paralelo que esquive la abstracción.
- [ ] **`sourceTimestamp` se preserva separado de `ingestedAt`.** Son cosas
      distintas: cuándo lo midió el sensor y cuándo lo recibimos nosotros.
      Colapsarlos hace imposible detectar un dato atrasado.
- [ ] Normaliza a mg/dL o declara su unidad. LibreView puede devolver mmol/L;
      un número crudo sin unidad se cuela hasta el resumen de IA.
- [ ] Marca el `origin` correcto (`real` | `synthetic` | `imported` | `manual`).
      **Un dato sintético o importado nunca puede leerse como sensor en vivo.**
- [ ] Valida toda respuesta externa con Zod antes de que entre al dominio.
- [ ] **Degrada a registro manual** ante fallo, y lo dice. Nunca inventa datos
      para rellenar.
- [ ] Los secretos del provider viven en el backend
      (`apps/api/src/config.ts`), **jamás** en `apps/mobile`.
- [ ] Tiene test de normalización en `packages/cgm/test/` — incluyendo el caso
      de unidad, el de dato atrasado y el de respuesta malformada.

## Al agregar uno

1. Archivo en `packages/cgm/src/`, exportado desde `index.ts`
   (**sin extensión `.js`** en el import relativo: `packages/cgm` lo bundlea
   Metro, que no reescribe `.js` → `.ts`).
2. Test en `packages/cgm/test/`.
3. Fila en la tabla de arriba.
4. ADR nuevo en `docs/adr/` si cambia cuál es el provider de producción.
5. Entrada en `docs/CODE_MAP.md`.
