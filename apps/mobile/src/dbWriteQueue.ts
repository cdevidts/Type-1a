/**
 * La cola que serializa **toda** escritura transaccional contra la conexión
 * SQLite de la app.
 *
 * ## El bug que arregla
 *
 * `expo-sqlite` implementa `withTransactionAsync` como `BEGIN` / trabajo /
 * `COMMIT` sobre la conexión compartida, con el `BEGIN` **dentro** del `try`:
 *
 * ```js
 * try { await execAsync('BEGIN'); await task(); await execAsync('COMMIT'); }
 * catch (e) { await execAsync('ROLLBACK'); throw e; }
 * ```
 *
 * SQLite no anida transacciones. Si B empieza mientras A tiene la suya
 * abierta, el `BEGIN` de B falla y su `catch` ejecuta un **`ROLLBACK` que no
 * es suyo**: cierra la transacción de A. A sigue corriendo sus `runAsync`
 * ya **sin transacción** —se aplican sueltos, sin atomicidad— y su `COMMIT`
 * termina fallando con "cannot commit - no transaction is active". Ese fallo
 * entra al `catch` de A, cuyo `ROLLBACK` también falla y **reemplaza el error
 * original**. A le reporta a la usuaria "no se pudo guardar" después de haber
 * escrito parte de sus filas.
 *
 * Eso es exactamente el síntoma que reportó Verónica: la app abierta un rato
 * deja de guardar y solo cerrarla y reabrirla la arregla.
 *
 * ## Quiénes chocaban
 *
 * No hacía falta un doble toque. `refresh()` en `App.tsx` escribe lecturas
 * CGM con `upsertCGMReadings` en cada arranque y en **cada transición de
 * `AppState` a `active`** — es decir, cada vez que se vuelve de la cámara, del
 * selector de fotos, de la sombra de notificaciones u otra app. Sacar la foto
 * de una comida y tocar Guardar al volver es la colisión más fácil de
 * producir, y explica el "incluso al poco tiempo de haberla abierto".
 *
 * ## Por qué una sola cola y no una por camino
 *
 * Una cola por camino no sirve: dos colas distintas contra la **misma**
 * conexión se anidan igual. Esta es la única, y por eso vive en su propio
 * módulo en vez de dentro de la función que la necesitó primero.
 *
 * ## Lo que esta cola NO cubre
 *
 * Las escrituras sueltas (`db.runAsync` fuera de una transacción) no pasan por
 * acá. No pueden anidar un `BEGIN` —son atómicas por sí solas— pero sí pueden
 * ejecutarse *dentro* de la transacción de otro y volver atrás con ella si esa
 * transacción falla. Es una ventana angosta y de bajo daño (ajustes, no
 * historial clínico), anterior a este arreglo; cerrarla exige encolar también
 * cada lectura y escritura suelta.
 *
 * La tarea de fondo tampoco pasa por acá y no lo necesita: desde este mismo
 * commit abre su **propia** conexión (`useNewConnection`), así que ya no
 * comparte transacción con la pantalla. Ver `backgroundSync.ts`.
 */

export type WriteQueue = <T>(work: () => Promise<T>) => Promise<T>;

/**
 * Crea una cola FIFO independiente. La app usa la única de abajo; esta fábrica
 * existe para que los tests puedan aislar una cola por caso.
 *
 * Dos garantías, ambas con test:
 *
 * 1. **Un fallo no envenena la cola.** El siguiente en la fila corre igual.
 *    Una cola que se traba con el primer error convierte un guardado fallido
 *    en una app muerta, que es el bug que vinimos a arreglar.
 * 2. **Cada quien ve su propio error.** El rechazo se le entrega al que
 *    encoló ese trabajo y a nadie más.
 */
export function createWriteQueue(): WriteQueue {
  let tail: Promise<unknown> = Promise.resolve();

  return <T>(work: () => Promise<T>): Promise<T> => {
    // `then(work, work)` y no `finally`: la cola avanza tanto si el anterior
    // resolvió como si falló.
    const run = tail.then(work, work);
    tail = run.catch(() => undefined);
    return run;
  };
}

/**
 * La cola de la conexión de la app. Es un singleton de módulo a propósito:
 * hay exactamente una conexión larga (`SQLiteProvider` en `App.tsx`), así que
 * una segunda cola sería un segundo camino hacia el mismo `BEGIN` anidado.
 */
export const serializeWrite: WriteQueue = createWriteQueue();
