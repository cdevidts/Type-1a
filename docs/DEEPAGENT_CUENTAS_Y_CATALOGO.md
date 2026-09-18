# Prompt para DeepAgent — cuentas y el catálogo en la base de datos

Sigue el criterio de `DEEPAGENT_REDEPLOY_PROMPT.md`: **la mayor cantidad de
cambio por la menor cantidad de tokens**, y todo lo que se pueda construir en
este repo se construye acá antes de pedirle nada a DeepAgent.

Pega lo que está **debajo de la línea** tal cual, en una sola corrida.

---

Estás trabajando en el backend Fastify de **Type 1A**, una app de registro para
diabetes tipo 1. Ya está desplegado, ya tiene Postgres (`DATABASE_URL`) y ya
tiene una tabla `food_catalog` anónima con dos endpoints (`GET`/`POST
/v1/food-catalog`). No rompas nada de eso.

## LA FRONTERA QUE NO SE CRUZA — léela antes que el resto

Esta base de datos **no puede guardar ningún dato de salud**. Ni glucosa, ni
insulina, ni comidas registradas, ni horarios de comida, ni notas, ni peso, ni
cetonas, ni nada del historial de una persona. Eso vive solo en el teléfono, por
decisión de arquitectura documentada y por la ley chilena 21.719 de protección
de datos.

Lo único que se guarda acá es: **una cuenta para poder cobrar una suscripción**,
y **un catálogo de alimentos** (nombres y macros por 100 g, más su foto). Un
alimento no es un dato de salud: "arroz cocido tiene 28 g de carbohidratos por
100 g" no dice nada de nadie.

**No agregues tablas, columnas ni endpoints para sincronizar historial médico,
aunque parezca útil y aunque la app se vea incompleta sin eso. Es deliberado.**
Si crees que falta algo así, dilo en el resumen final en vez de construirlo.

## Qué construir

### 1. Cuentas

Tabla `users`:

- `id` uuid primary key
- `email` citext unique not null
- `password_hash` text not null
- `email_verified_at` timestamptz null
- `created_at` timestamptz not null default now()
- `subscription_status` text not null default 'free'
- `subscription_expires_at` timestamptz null

Tabla `sessions`:

- `token_hash` text primary key — guarda el **hash** del token, nunca el token
- `user_id` uuid not null references users(id) on delete cascade
- `created_at`, `expires_at` timestamptz not null
- `revoked_at` timestamptz null

**Requisitos de seguridad, no negociables:**

- Contraseñas con **Argon2id**, mínimo 19 MiB de memoria, 2 iteraciones y
  paralelismo 1 (recomendación de OWASP). Nunca SHA, nunca MD5, nunca texto
  plano, nunca un hash sin sal.
- El token de sesión es **opaco y aleatorio** (32 bytes de
  `crypto.randomBytes`), no un JWT. Se guarda su SHA-256 en la tabla; el token
  en claro solo se le devuelve al cliente una vez. Motivo: hay que poder
  revocar una sesión al instante, y un JWT no se revoca.
- Sesiones de **30 días**, renovables. Al renovar se emite un token nuevo.
- **Rate limit en `/v1/auth/login` y `/v1/auth/register`**: máximo 10 intentos
  por IP cada 15 minutos. El proyecto ya usa `@fastify/rate-limit`.
- La respuesta de login fallido es **idéntica** si el correo no existe o si la
  contraseña está mal. No reveles cuál de los dos fue.
- **Nunca loguees** el cuerpo de una petición de auth, ni el token, ni el hash.

Endpoints:

- `POST /v1/auth/register` — `{ email, password }` → crea la cuenta y devuelve
  `{ token, expiresAt }`. Contraseña mínima 10 caracteres. Rechaza correos
  inválidos con Zod.
- `POST /v1/auth/login` — `{ email, password }` → `{ token, expiresAt }`.
- `POST /v1/auth/logout` — con el token en `Authorization: Bearer`, marca
  `revoked_at`.
- `GET /v1/auth/me` — devuelve `{ email, subscriptionStatus }`. Nada más.

### 2. El catálogo, ahora con dueño

La tabla `food_catalog` actual es anónima y compartida. **No la borres ni la
migres.** Agrega una columna:

- `owner_user_id` uuid null references users(id) on delete cascade

La regla es simple: `owner_user_id IS NULL` significa **catálogo de comunidad**
(lo que ya existe hoy, anónimo, servido a todos). `owner_user_id = <id>`
significa **catálogo personal de esa usuaria**.

La clave primaria pasa a ser `(coalesce(owner_user_id, '00000000-0000-0000-0000-000000000000'), key)`
o un índice único equivalente, para que dos usuarias puedan tener su propia
versión de "arroz" sin pisarse.

### 3. Las fotos de los alimentos

Tabla `catalog_photos`:

- `owner_user_id` uuid null references users(id) on delete cascade
- `food_key` text not null
- `bytes` bytea not null
- `mime_type` text not null default 'image/jpeg'
- `updated_at` timestamptz not null default now()
- primary key sobre `(coalesce(owner_user_id, …), food_key)`

**Rechaza cualquier imagen de más de 400 KB** con un 413 y un mensaje claro. La
app ya comprime a JPEG de calidad 0,72 antes de subir, así que 400 KB es
holgado; el límite existe para que nadie llene la base.

Endpoints:

- `GET /v1/catalog/photo/:foodKey` — con token, devuelve la foto personal; sin
  token, la de comunidad. `Cache-Control: private, max-age=86400`.
- `PUT /v1/catalog/photo/:foodKey` — con token, sube o reemplaza la personal.
- `DELETE /v1/catalog/photo/:foodKey` — con token.

### 4. El catálogo personal

- `GET /v1/catalog/mine` — con token, devuelve **todo** el catálogo personal de
  esa usuaria. Es lo que la app carga al iniciar sesión.
- `PUT /v1/catalog/mine` — con token, recibe un lote de alimentos ya
  normalizados por 100 g y los inserta o actualiza. Idempotente por `key`:
  mandar el mismo lote dos veces no duplica nada.
- `DELETE /v1/catalog/mine/:key` — con token.

Los endpoints existentes `GET`/`POST /v1/food-catalog` **siguen funcionando
igual que hoy** y siguen sirviendo el catálogo de comunidad (`owner_user_id IS
NULL`). No cambies su contrato: la app móvil los usa.

## Cómo hacerlo

- **El esquema se auto-provee al arrancar** con `CREATE TABLE IF NOT EXISTS` y
  `ALTER TABLE … ADD COLUMN IF NOT EXISTS`, igual que hace hoy `food_catalog`.
  Nada de migraciones manuales.
- **Valida todo input con Zod**, incluidos los parámetros de ruta.
- **Sin `DATABASE_URL` configurada**, los endpoints nuevos responden 503 y el
  resto del backend sigue funcionando exactamente igual. Es el patrón que ya usa
  cada integración externa.
- Un endpoint que necesita token y no lo recibe responde **401**, no 500.

## Qué NO hacer

- No agregues una librería de ORM. El proyecto usa `pg` con `Pool` y consultas
  escritas a mano.
- No agregues OAuth, ni login con Google, ni magic links. Correo y contraseña.
- No mandes correos todavía: deja `email_verified_at` en null y expón el campo.
  El envío se resuelve después.
- No toques nada de CGM ni de los endpoints de IA.
- No guardes datos de salud. Si el diseño parece pedirlo, no lo hagas y dilo.

## Cómo sé que quedó bien

Al terminar, dime en dos párrafos:

1. Qué tablas y endpoints quedaron, y qué responde cada uno sin token.
2. Con qué parámetros exactos quedó configurado Argon2id, y confirma que
   ninguna ruta loguea contraseñas ni tokens.

Y dame un `curl` de ejemplo para registrar una cuenta, iniciar sesión y subir un
alimento con su foto, para probarlo de punta a punta.
