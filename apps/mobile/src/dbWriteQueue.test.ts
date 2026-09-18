import { describe, expect, it } from 'vitest';

import { createWriteQueue } from './dbWriteQueue';

/** Un trabajo que se resuelve cuando el test lo decide. */
function deferred(): { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void } {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('createWriteQueue', () => {
  it('no deja que dos trabajos se solapen', async () => {
    const queue = createWriteQueue();
    const first = deferred();
    const log: string[] = [];

    const a = queue(async () => { log.push('a:inicio'); await first.promise; log.push('a:fin'); });
    const b = queue(async () => { log.push('b:inicio'); });

    // Este es el corazón del bug: sin cola, `b` empezaría acá y su `BEGIN`
    // caería dentro de la transacción de `a`.
    await Promise.resolve();
    expect(log).toEqual(['a:inicio']);

    first.resolve();
    await Promise.all([a, b]);
    expect(log).toEqual(['a:inicio', 'a:fin', 'b:inicio']);
  });

  it('respeta el orden en que se encoló', async () => {
    const queue = createWriteQueue();
    const log: number[] = [];
    await Promise.all([1, 2, 3, 4].map((n) => queue(async () => { log.push(n); })));
    expect(log).toEqual([1, 2, 3, 4]);
  });

  it('un fallo no traba a los que vienen después', async () => {
    const queue = createWriteQueue();
    const log: string[] = [];

    const failing = queue(async () => { throw new Error('escritura fallida'); });
    const next = queue(async () => { log.push('siguió'); return 'ok'; });

    await expect(failing).rejects.toThrow('escritura fallida');
    await expect(next).resolves.toBe('ok');
    expect(log).toEqual(['siguió']);
  });

  it('le entrega el error solo a quien encoló ese trabajo', async () => {
    const queue = createWriteQueue();
    const failing = queue(async () => { throw new Error('solo mío'); });
    const other = queue(async () => 42);

    await expect(failing).rejects.toThrow('solo mío');
    await expect(other).resolves.toBe(42);
  });

  it('devuelve el valor de cada trabajo a su propio llamador', async () => {
    const queue = createWriteQueue();
    const [a, b] = await Promise.all([queue(async () => 'a'), queue(async () => 'b')]);
    expect([a, b]).toEqual(['a', 'b']);
  });

  it('mantiene el orden aunque el primero falle a mitad de camino', async () => {
    const queue = createWriteQueue();
    const first = deferred();
    const log: string[] = [];

    const a = queue(async () => { log.push('a'); await first.promise; });
    const b = queue(async () => { log.push('b'); });

    await Promise.resolve();
    expect(log).toEqual(['a']);
    first.reject(new Error('rollback'));

    await expect(a).rejects.toThrow('rollback');
    await b;
    expect(log).toEqual(['a', 'b']);
  });

  it('dos colas distintas no se coordinan entre sí', async () => {
    // Regresión de diseño: por esto la app tiene UNA cola y no una por
    // camino. Dos colas contra la misma conexión anidan el `BEGIN` igual.
    const one = createWriteQueue();
    const two = createWriteQueue();
    const held = deferred();
    const log: string[] = [];

    const a = one(async () => { log.push('a:inicio'); await held.promise; });
    const b = two(async () => { log.push('b:inicio'); });

    await Promise.resolve();
    expect(log).toEqual(['a:inicio', 'b:inicio']);

    held.resolve();
    await Promise.all([a, b]);
  });
});
