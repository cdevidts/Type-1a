import { describe, expect, it } from 'vitest';

import { LibreLinkUpCGMProvider, parseLibreFactoryTimestamp } from '../src/index.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

const LOGIN_OK = {
  status: 0,
  data: {
    authTicket: { token: 'test-token', expires: 9_999_999_999, duration: 3600 },
    user: { id: 'user-1' },
  },
};

const CONNECTIONS_OK = {
  status: 0,
  data: [
    {
      patientId: 'patient-1',
      firstName: 'Cristobal',
      lastName: 'De Vidts',
      glucoseMeasurement: { FactoryTimestamp: '8/17/2026 4:01:29 PM', ValueInMgPerDl: 146, TrendArrow: 3 },
    },
  ],
};

describe('LibreLinkUp normalization', () => {
  it('interprets FactoryTimestamp as UTC wall-clock time', () => {
    expect(parseLibreFactoryTimestamp('8/17/2026 4:01:29 PM')).toBe('2026-08-17T16:01:29.000Z');
    expect(parseLibreFactoryTimestamp('1/5/2026 12:00:00 AM')).toBe('2026-01-05T00:00:00.000Z');
  });

  it('logs in, follows a region redirect once, and returns the latest reading', async () => {
    const calls: string[] = [];
    const fetcher: typeof fetch = async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.includes('api-eu.libreview.io/llu/auth/login')) {
        return jsonResponse({ status: 0, data: { redirect: true, region: 'LA' } });
      }
      if (url.includes('api-la.libreview.io/llu/auth/login')) {
        return jsonResponse(LOGIN_OK);
      }
      if (url.includes('/llu/connections')) {
        return jsonResponse(CONNECTIONS_OK);
      }
      throw new Error(`unexpected url: ${url}`);
    };

    const provider = new LibreLinkUpCGMProvider({
      email: 'test@example.com',
      password: 'secret',
      region: 'eu',
      fetcher,
      now: () => new Date('2026-08-17T16:05:00.000Z'),
    });

    const latest = await provider.getLatestReading();
    expect(latest).toMatchObject({ glucose: 146, origin: 'real', trend: 'stable', unit: 'mg/dL' });
    expect(calls.some((url) => url.includes('api-eu.libreview.io'))).toBe(true);
    expect(calls.some((url) => url.includes('api-la.libreview.io'))).toBe(true);
  });

  it('breaks a multi-hop region redirect cycle instead of recursing forever', async () => {
    const fetcher: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes('api-eu.libreview.io')) return jsonResponse({ status: 0, data: { redirect: true, region: 'US' } });
      if (url.includes('api-us.libreview.io')) return jsonResponse({ status: 0, data: { redirect: true, region: 'EU' } });
      throw new Error(`unexpected url: ${url}`);
    };
    const provider = new LibreLinkUpCGMProvider({
      email: 'test@example.com',
      password: 'secret',
      region: 'eu',
      fetcher,
      now: () => new Date('2026-08-17T16:05:00.000Z'),
    });

    expect(await provider.getStatus()).toMatchObject({ state: 'provider_error', isSynthetic: false });
  });

  it('maps invalid credentials to authentication_required without retrying forever', async () => {
    const fetcher: typeof fetch = async () => jsonResponse({ status: 2, data: {} });
    const provider = new LibreLinkUpCGMProvider({
      email: 'test@example.com',
      password: 'wrong',
      region: 'la',
      fetcher,
      now: () => new Date('2026-08-17T16:05:00.000Z'),
    });

    expect(await provider.getStatus()).toMatchObject({ state: 'authentication_required', isSynthetic: false });
  });

  it('maps HTTP 401 to authentication_required', async () => {
    const fetcher: typeof fetch = async () => new Response('', { status: 401 });
    const provider = new LibreLinkUpCGMProvider({
      email: 'test@example.com',
      password: 'wrong',
      region: 'la',
      fetcher,
      now: () => new Date('2026-08-17T16:05:00.000Z'),
    });

    expect(await provider.getStatus()).toMatchObject({ state: 'authentication_required', isSynthetic: false });
  });
});
