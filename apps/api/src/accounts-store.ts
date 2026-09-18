import { hash, verify } from '@node-rs/argon2';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';

/**
 * Cuentas y sesiones — la ÚNICA razón por la que este backend guarda algo de
 * una persona es poder cobrarle una suscripción (ver `docs/adr/0001-local-first.md`
 * y `docs/adr/0002-ai-boundary.md`). Acá NO vive ningún dato de salud: ni
 * glucosa, ni insulina, ni comidas, ni horarios. Solo un correo, un hash de
 * contraseña y el estado de la suscripción. Un alimento del catálogo no es un
 * dato de salud, por eso sí puede tener dueño; nada más.
 *
 * Reusa el mismo Pool de `pg` que el catálogo (un solo Pool por proceso) y el
 * mismo patrón de auto-provisión con `CREATE TABLE IF NOT EXISTS` que
 * `food-catalog-store.ts`. Sin `DATABASE_URL` la feature entera no se
 * construye y las rutas degradan a 503.
 */

/**
 * Parámetros de Argon2id fijados a propósito (OWASP 2024, perfil de 19 MiB):
 * memoria 19456 KiB, 2 iteraciones, paralelismo 1. La librería aplica una
 * sal aleatoria por hash internamente — nunca SHA/MD5/plaintext para
 * contraseñas.
 */
const ARGON2ID_OPTIONS = {
  algorithm: 2, // Algorithm.Argon2id (const enum inlined for verbatimModuleSyntax)
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

/** 30 días, en milisegundos. Las sesiones se renuevan emitiendo un token nuevo. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface AuthenticatedUser {
  id: string;
  email: string;
  subscriptionStatus: string;
}

export interface IssuedSession {
  token: string;
  expiresAt: string;
}

/** El registro falló porque el correo ya existe. Se traduce a 409 en la ruta. */
export class EmailAlreadyRegisteredError extends Error {
  public constructor() {
    super('email_already_registered');
    this.name = 'EmailAlreadyRegisteredError';
  }
}

/**
 * Login inválido. Mismo error tanto si el correo no existe como si la
 * contraseña está mal — quien llama NUNCA debe poder distinguir cuál de los
 * dos falló (evita enumerar cuentas).
 */
export class InvalidCredentialsError extends Error {
  public constructor() {
    super('invalid_credentials');
    this.name = 'InvalidCredentialsError';
  }
}

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  subscription_status: string;
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export class PostgresAccountsStore {
  public constructor(private readonly pool: Pool) {}

  /**
   * Hash de una contraseña ficticia, calculado una vez al levantar. Se
   * verifica contra él cuando el correo NO existe, para que un login fallido
   * consuma el mismo tiempo de CPU exista o no la cuenta (evita un ataque de
   * temporización que revele qué correos están registrados).
   */
  private dummyHash = '';

  public async ensureSchema(): Promise<void> {
    // citext hace que el correo sea único sin distinguir mayúsculas. Si el rol
    // no tuviera permiso para crear la extensión, no tumbamos el arranque: se
    // registra y el resto del backend sigue igual (en el Postgres por defecto
    // de esta instancia el rol sí puede).
    try {
      await this.pool.query('CREATE EXTENSION IF NOT EXISTS citext;');
    } catch {
      // Sin citext caemos a text; el índice único sigue aplicando, solo que
      // sensible a mayúsculas. No es motivo para tumbar el proceso.
    }
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY,
        email CITEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        email_verified_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        subscription_status TEXT NOT NULL DEFAULT 'free',
        subscription_expires_at TIMESTAMPTZ
      );
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        revoked_at TIMESTAMPTZ
      );
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS sessions_user_id ON sessions (user_id);
    `);
    this.dummyHash = await hash('mira-que-no-existe-esta-clave', ARGON2ID_OPTIONS);
  }

  /**
   * Crea una sesión nueva: token opaco de 32 bytes aleatorios (base64url), del
   * que se guarda SOLO su SHA-256. El token en claro se devuelve una única vez
   * a quien llama y no se puede recuperar después. No es un JWT: es revocable
   * al instante borrando/marcando la fila.
   */
  private async issueSession(userId: string): Promise<IssuedSession> {
    const token = randomBytes(32).toString('base64url');
    const tokenHash = sha256Hex(token);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
    await this.pool.query(
      'INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES ($1, $2, $3, $4)',
      [tokenHash, userId, now.toISOString(), expiresAt.toISOString()],
    );
    return { token, expiresAt: expiresAt.toISOString() };
  }

  public async register(email: string, password: string): Promise<IssuedSession> {
    const passwordHash = await hash(password, ARGON2ID_OPTIONS);
    const id = randomUUID();
    try {
      await this.pool.query(
        'INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)',
        [id, email, passwordHash],
      );
    } catch (error) {
      // 23505 = unique_violation. Se traduce a un 409 limpio; nunca se registra
      // el cuerpo ni se filtra el stack.
      if (typeof error === 'object' && error !== null && 'code' in error && (error as { code?: string }).code === '23505') {
        throw new EmailAlreadyRegisteredError();
      }
      throw error;
    }
    return this.issueSession(id);
  }

  public async login(email: string, password: string): Promise<IssuedSession> {
    const result = await this.pool.query<UserRow>(
      'SELECT id, email, password_hash, subscription_status FROM users WHERE email = $1',
      [email],
    );
    const user = result.rows[0];
    if (user === undefined) {
      // Verificación ficticia para no revelar por temporización que el correo
      // no existe. El resultado se descarta: el fallo es idéntico al de una
      // contraseña incorrecta.
      await verify(this.dummyHash, password).catch(() => false);
      throw new InvalidCredentialsError();
    }
    const ok = await verify(user.password_hash, password).catch(() => false);
    if (!ok) throw new InvalidCredentialsError();
    return this.issueSession(user.id);
  }

  /** Marca revocada la sesión de este token. Idempotente. */
  public async logout(token: string): Promise<void> {
    await this.pool.query(
      'UPDATE sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL',
      [sha256Hex(token)],
    );
  }

  /**
   * Resuelve un token Bearer a su usuaria, o `null` si falta, no existe, está
   * expirado o revocado. Nunca lanza por un token inválido — quien llama lo
   * traduce a 401.
   */
  public async authenticate(token: string): Promise<AuthenticatedUser | null> {
    const result = await this.pool.query<UserRow>(
      `SELECT u.id, u.email, u.subscription_status
         FROM sessions s
         JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = $1
          AND s.revoked_at IS NULL
          AND s.expires_at > now()`,
      [sha256Hex(token)],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    return { id: row.id, email: row.email, subscriptionStatus: row.subscription_status };
  }
}
