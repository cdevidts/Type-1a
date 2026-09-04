# Plan — cuentas de usuaria y sincronización completa con Supabase

Escrito el 2026-09-03 a pedido de Verónica: *"Todo se tiene que sincronizar,
todo. Cuentas con correo y contraseña, que se carguen tus datos. Esto es un
paso más cercano a poder monetizar."*

Proyecto ya creado: `kvhlttcvjamgybwlamcu` · us-east-1 · Postgres 17 · vacío.

---

## 0. Lo primero, porque cambia el calendario

**La Ley 21.719 entra en plena vigencia el 1 de diciembre de 2026** — dentro de
menos de tres meses. Clasifica los **datos de salud como categoría de máxima
protección**, obliga a toda organización que trate datos de residentes en Chile
sin importar su tamaño, exige notificar una brecha a la Agencia **dentro de 72
horas**, y las multas llegan a 20.000 UTM.

Hoy eso no aplica: los datos viven en el teléfono de Verónica y de nadie más.
**Desde el día en que exista la primera cuenta de otra persona, sí aplica.** No
es un detalle a resolver al final; es lo que decide si esto se puede lanzar.

Consecuencia concreta para este plan: la Fase 4 (cumplimiento) **no es
opcional ni posterior al lanzamiento**. Va antes de la primera usuaria real que
no sea ella.

---

## 1. Lo que se está revocando

`docs/adr/0001-local-first.md` dice que el timeline vive solo en el teléfono, y
de ahí sale media arquitectura: SQLCipher, el keystore intocable, "sin backup
en la nube". Esto lo cambia, y necesita **ADR 0007** que lo diga explícitamente
en vez de dejar dos documentos contradiciéndose (lo que ya pasó con
`safety-acceptance.md` y el IOB).

Hay un detalle que hace la decisión urgente además de deseable: la clave de
SQLCipher se guarda con `WHEN_UNLOCKED_THIS_DEVICE_ONLY` (`db.ts:87-91`). **No
sale del dispositivo, por diseño.** Hoy, si Verónica pierde el teléfono, su
historial clínico es irrecuperable — no hay copia y no habría cómo descifrarla.
Sincronizar no es solo una función nueva: es el primer respaldo que va a
existir.

---

## 2. La decisión que hay que tomar primero: ¿el servidor puede leer los datos?

Dos caminos, y son excluyentes.

**A · RLS estricta (recomendado).** El dato viaja cifrado en tránsito, se
guarda en Postgres, Supabase lo cifra en reposo, y Row Level Security garantiza
que cada usuaria solo vea lo suyo. Supabase (o quien tenga la clave de servicio)
podría leerlo técnicamente.

**B · Cifrado extremo a extremo.** El teléfono cifra antes de subir; nadie en el
servidor puede leer nada.

**Recomiendo A, y no por comodidad:**

- Con B, **olvidar la contraseña = perder el historial clínico para siempre**.
  No hay recuperación posible. En una app médica eso es inaceptable.
- Con B **no hay catálogo maestro compartido** — lo que ella pidió
  explícitamente hace unas semanas. Si nadie puede leer los alimentos, no se
  pueden agregar entre usuarias.
- Con B no hay reporte del lado servidor, ni métricas agregadas, ni soporte
  ("no puedo ver tu cuenta ni para ayudarte").

Lo que sí se hace con A, y no es negociable:

- `user_id` obligatorio en **toda** tabla, con RLS `auth.uid() = user_id`.
- **La clave `service_role` nunca sale del backend.** El teléfono usa la
  `anon key`, que sin sesión no lee nada. Es el error clásico de Supabase:
  una tabla sin RLS o una clave de servicio en la app y cualquiera lee todo.
- Un test de integración que intente leer los datos de otra usuaria **y falle**.
  Sin ese test, RLS es una intención.

---

## 3. Esquema

Una tabla por cada tabla local, más las de cuenta. Todas con la misma columna
vertebral:

```sql
user_id     uuid not null references auth.users(id) on delete cascade,
updated_at  timestamptz not null default now(),
deleted_at  timestamptz,          -- borrado lógico, ver §4
client_id   text not null          -- el id que ya usa SQLite
primary key (user_id, client_id)
```

Tablas: `cgm_readings`, `insulin_events`, `carb_events`, `meal_events`,
`water_events`, `note_events`, `vitals_events`, `activity_events`,
`meal_episodes`, `hba1c_results`, `therapy_profile`, `nutrition_profile`,
`entry_groups`, `recipes`, `recipe_items`.

**`food_catalog` es la excepción y va aparte**: es el catálogo maestro
compartido del ADR 0003. Filas sin `user_id`, de lectura pública, escritura
solo por el backend. Un alimento no es dato de salud de nadie; el plato que
alguien comió sí. Mezclarlos sería el error.

Tres reglas que se deciden ahora porque después cuestan una migración:

1. **`updated_at` lo pone el servidor** (`now()` en un trigger), nunca el
   teléfono. El reloj del teléfono se puede mover — la app ya tiene el caso
   documentado de dosis con hora futura — y un reloj adelantado ganaría todos
   los conflictos para siempre.
2. **La clave primaria es `(user_id, client_id)`**, no un uuid nuevo. Así el id
   que la fila ya tiene en SQLite sigue siendo su identidad, y subir dos veces
   la misma fila no la duplica (`on conflict do update`).
3. **`on delete cascade` desde `auth.users`**: borrar la cuenta borra el dato.
   La Ley 21.719 da derecho a supresión; que sea una restricción de la base y
   no un procedimiento manual es la diferencia entre cumplirlo y prometerlo.

---

## 4. Sincronización

**Modelo: local-first con cola de salida y pull incremental.** El teléfono
sigue escribiendo primero en SQLite y la app sigue funcionando sin señal —
`AGENTS.md` exige degradar a registro manual y eso no cambia.

**Push.** Cada escritura local encola una operación. Un trabajador la sube con
reintento y backoff exponencial. La cola se reusa del patrón que ya existe:
`dbWriteQueue.ts` es una cola FIFO probada, y `backgroundSync.ts` ya sabe correr
en segundo plano con su propia conexión.

**Pull.** Por tabla, `where updated_at > <último visto>`, paginado. Se guarda un
cursor por tabla, no uno global: si una tabla falla, las demás avanzan.

**Conflictos: last-write-wins por fila**, con el `updated_at` del servidor. Es
suficiente y es honesto para este caso — **una sola persona en varios
dispositivos**, no colaboración. CRDTs resolverían un problema que esta app no
tiene.

**Borrados: lógicos, con `deleted_at`.** Hoy `db.ts` hace `DELETE` duro, y un
borrado duro **no se puede sincronizar**: la fila desaparece y el otro
dispositivo no tiene cómo enterarse, así que la resucita en el siguiente pull.
Es el bug clásico de toda primera sincronización. Cambiar los `DELETE` por
`deleted_at` es trabajo de la Fase 2 y toca `db.ts` en unos quince sitios.

**Lo que NO se sincroniza en la primera versión:**

- **Las fotos de comida.** `imageUri` es una ruta local; sincronizar la ruta sin
  el archivo deja fotos rotas en el teléfono nuevo. Van a Supabase Storage en
  una fase aparte (1 GB gratis ≈ 2.500 fotos a 400 KB).
- **La clave de SQLCipher**, los tokens de LibreLinkUp y cualquier secreto.

---

## 5. Cuentas

Supabase Auth con correo y contraseña. Tres reglas de producto:

1. **La cuenta es opcional al principio.** Forzar login rompería a quien ya usa
   la app — hoy, ella. Sin cuenta la app funciona exactamente como ahora.
2. **Al crear la cuenta se sube todo lo local**, en una migración única y
   visible, con su barra de progreso y su "no cierres la app". Es el momento de
   mayor riesgo del proyecto entero: si falla a medias, hay que poder
   reintentarla sin duplicar. De ahí la clave `(user_id, client_id)`.
3. **Cerrar sesión no borra lo local.** Preguntar "¿borrar los datos de este
   dispositivo?" por separado, con la respuesta segura por defecto.

Verificación de correo obligatoria antes de sincronizar: si el correo no es
suyo, la recuperación de contraseña entrega el historial clínico a otra persona.

---

## 6. Migración de lo que ya está en el teléfono

Hoy hay meses de datos de Verónica y **no hay respaldo**. El orden importa:

1. **Exportar antes de tocar nada.** La app ya sabe generar PDF y Excel del
   rango completo: eso es el respaldo humano, y se hace antes de la primera
   prueba de sincronización.
2. Probar la subida con una cuenta de prueba y datos de prueba, nunca con los
   suyos.
3. Subir los suyos solo cuando el camino de vuelta —cuenta nueva en un
   dispositivo limpio, descarga completa, comparación con el Excel— esté
   probado.

---

## 7. Costos reales

| | Free | Pro |
|---|---|---|
| Precio | $0 | **$25/mes** |
| Base de datos | 500 MB | 8 GB (+$0,125/GB) |
| Usuarias activas/mes | 50.000 | 100.000 |
| Egress | 5 GB | 250 GB |
| **Pausa por inactividad** | **sí, a la semana** | nunca |

**El plan gratis no sirve para producción**: se pausa tras una semana sin
actividad, y una app de salud que no abre el domingo no puede estar caída el
lunes.

**Cuánto pesa una usuaria.** Lo que domina es el CGM: una lectura cada 5 min son
~105.000 filas al año, ~10-15 MB con el overhead de Postgres. Todo lo demás
—insulina, comidas, agua, notas— es ~1 MB al año.

- **500 MB (Free)** ≈ 33 usuarias-año.
- **8 GB (Pro)** ≈ 530 usuarias-año.

Con las 100 usuarias que ella mencionó, el Pro aguanta unos 5 años de historia
completa. La palanca, si alguna vez aprieta, es archivar el CGM crudo con más de
un año y conservar los agregados — no comprar más disco.

---

## 8. Fases

**Fase 1 · Cuentas, sin sincronizar nada** (la más segura de todas)
Supabase Auth, pantalla de registro/ingreso, sesión persistida, verificación de
correo. La app sigue 100 % local. Entregable: se puede crear una cuenta y no
pasa nada más. ADR 0007 escrito.

**Fase 2 · Preparar los datos para poder sincronizarse**
Borrado lógico en las quince tablas, `updated_at` local, la cola de salida.
Todavía sin servidor. Entregable: `pnpm verify` verde y la app se comporta
igual, con los borrados ahora reversibles.

**Fase 3 · Sincronización real**
Esquema en Supabase con RLS + el test que intenta leer los datos ajenos y falla.
Push, pull, cursores, reintentos. Migración inicial con progreso. Pantalla de
estado ("sincronizado hace 2 min", "3 cambios pendientes", "sin conexión").

**Fase 4 · Cumplimiento — antes de la primera usuaria que no sea ella**
Política de privacidad y consentimiento explícito para datos de salud; export
completo (derecho de acceso) y borrado de cuenta (derecho de supresión), los dos
desde la app; registro de tratamiento; procedimiento de notificación de brecha
en 72 h. Sin esto no se abre a nadie más.

**Fase 5 · Fotos a Storage.**

**Fase 6 · Monetización.** Suscripción, y con ella la decisión de qué queda
gratis. Va última a propósito: cobrar por algo que todavía no sincroniza bien
es la peor versión de este proyecto.

---

## 9. Lo que este plan NO propone

- **Ni PowerSync ni ElectricSQL.** Resuelven sincronización multi-usuario en
  tiempo real; acá hay una persona en dos dispositivos. Un servicio más, con su
  costo y su modo de fallar, para un problema que un cursor y una cola cubren.
- **Ni CRDTs**, por lo mismo.
- **No mover el cálculo clínico al servidor.** `packages/domain` sigue siendo
  puro y local: la app tiene que poder calcular una dosis sin señal, y
  `AGENTS.md` lo exige.
- **No sincronizar en tiempo real.** Un push por cambio y un pull al abrir y
  cada X minutos alcanza. Realtime consume egress y no aporta nada a una sola
  persona.

---

## 10. Decisiones tomadas — 4 de septiembre de 2026

Verónica respondió las tres. El plan queda cerrado sobre esto:

1. **Camino A (RLS).** El servidor puede leer los datos; una política por fila
   impide que una usuaria vea las de otra. Se descarta E2EE porque rompe la
   recuperación de contraseña y hace imposible el soporte. Queda anotado que
   E2EE tenía a favor un argumento legal real —una brecha expondría datos
   ilegibles— y que se eligió A a pesar de eso, no por ignorarlo.
2. **Free mientras la use solo ella; Pro el día que exista la segunda cuenta.**
   El proyecto Free se apaga tras una semana sin uso: aceptable para una
   usuaria, inaceptable para una clienta.
3. **La app sigue funcionando sin cuenta, para siempre.** La cuenta es opcional
   y sirve para respaldar y cambiar de teléfono. Al crearla, lo que ya está en
   el teléfono se sube; al cerrar sesión, lo local no se borra.

### Sobre el consentimiento

Preguntó si lo legal se resuelve con un formulario al iniciar. No: el
consentimiento expreso es la **base legal** para tratar datos de salud y hay que
tenerlo, pero es una obligación entre varias. No cubre las medidas de seguridad,
la notificación de brecha en 72 h, ni los derechos ARCOP —acceso,
rectificación, supresión, oposición, portabilidad y bloqueo—, que son pantallas
y botones que hay que construir. Tampoco cubre que retirar el consentimiento
deba ser tan fácil como darlo. Eso es la Fase 4 completa, no un checkbox.

El texto del consentimiento y la política de privacidad los revisa un abogado
antes de la primera usuaria que no sea ella. No es opcional y no lo suple este
documento.
