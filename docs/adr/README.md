# Decisiones de arquitectura (ADR)

**Capa 3 — append-only.** Un ADR registra una decisión y el contexto en que se
tomó; su valor está justamente en que sobrevive a la decisión.

- **Nunca se renumera, nunca se reusa un número, nunca se borra un archivo.**
  Que un ADR tenga siete líneas no es un defecto: es un ADR bien escrito.
- Una decisión que dejó de valer **se marca**, no se borra: `status: Superseded
  by ADR-000N` o `Deprecated`, y el ADR que la reemplaza la cita.
- Esta tabla es lo único que enlaza el Memory Bank. Los ADR completos se leen
  just-in-time, cuando hace falta el contexto de la decisión.

| # | Decisión | Estado |
|---|---|---|
| [0001](0001-local-first.md) | Almacenamiento de eventos local-first | Accepted (2026-08-12) |
| [0002](0002-ai-boundary.md) | La IA interpreta; el código determinístico calcula | Accepted (2026-08-12) |
| [0003](0003-shared-food-catalog.md) | Catálogo de alimentos compartido — el backend gana estado, acotado | Accepted (2026-08-21) |
| [0004](0004-cgm-provider-librelinkup.md) | LibreLinkUp es la ruta de CGM; Junction queda como alternativa | Accepted (2026-08-26) |
| [0005](0005-insulin-on-board.md) | Insulina activa (IOB): se levanta la prohibición, con cinco condiciones | Accepted (2026-09-02) |
| [0006](0006-iob-de-comida-si-cuenta-pero-nunca-toca-la-comida.md) | El IOB incluye la insulina de comida, pero nunca toca la cobertura de carbohidratos | Accepted (2026-09-03) |

## Cuándo escribir uno

Cuando la decisión sea cara de revertir y su **porqué** no se deduzca del
código: qué proveedor externo es el de producción, dónde vive un estado nuevo,
qué frontera de seguridad es estructural y por qué.

No lleva ADR lo que un contrato de `/contracts/` ya gobierna, ni un cambio que
el propio cuerpo del commit explica completo.
