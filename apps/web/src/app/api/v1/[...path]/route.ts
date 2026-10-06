import { cookies } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';

async function relay(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  const origin = request.headers.get('origin');
  const host = request.headers.get('host');
  let sameOrigin = false;
  try { sameOrigin = !!origin && !!host && new URL(origin).host === host && (process.env.NODE_ENV !== 'production' || new URL(origin).protocol === 'https:'); } catch { /* invalid Origin */ }
  if (request.method !== 'GET' && !sameOrigin) return NextResponse.json({ statusCode: 403, code: 'BAD_ORIGIN', message: 'Invalid origin' }, { status: 403 });
  const api = process.env.API_URL;
  if (!api) return NextResponse.json({ statusCode: 503, code: 'CONFIG_ERROR', message: 'API_URL is missing' }, { status: 503 });
  const cookieStore = await cookies();
  const token = cookieStore.get('umh_session')?.value;
  const isLogin = path.join('/') === 'auth/login';
  const isLogout = path.join('/') === 'auth/logout';
  if (isLogout) {
    const response = NextResponse.json({ success: true });
    response.cookies.delete('umh_session');
    return response;
  }
  if (!isLogin && !token) return NextResponse.json({ statusCode: 401, code: 'UNAUTHORIZED', message: 'Sign in required' }, { status: 401 });
  try {
    const upstream = await fetch(`${api}/api/v1/${path.map(encodeURIComponent).join('/')}${request.nextUrl.search}`, {
      method: request.method,
      headers: { 'Content-Type': 'application/json', ...(token && !isLogin ? { Authorization: `Bearer ${token}` } : {}), ...(request.headers.get('idempotency-key') ? { 'Idempotency-Key': request.headers.get('idempotency-key')! } : {}) },
      body: request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.text(),
      cache: 'no-store',
    });
    if (!upstream.headers.get('content-type')?.includes('application/json')) {
      const headers = new Headers({ 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin' });
      for (const name of ['content-type', 'content-disposition']) {
        const value = upstream.headers.get(name);
        if (value) headers.set(name, value);
      }
      return new NextResponse(upstream.body, { status: upstream.status, headers });
    }
    const data: unknown = await upstream.json();
    if (isLogin && upstream.ok && typeof data === 'object' && data !== null && 'token' in data && typeof data.token === 'string') {
      const response = NextResponse.json({ user: 'user' in data ? data.user : null });
      response.cookies.set('umh_session', data.token, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/', maxAge: 8 * 60 * 60 });
      return response;
    }
    return NextResponse.json(data, { status: upstream.status });
  } catch {
    return NextResponse.json({ statusCode: 503, code: 'API_UNAVAILABLE', message: 'API is unavailable' }, { status: 503 });
  }
}
export const GET = relay;
export const POST = relay;
export const PATCH = relay;
export const PUT = relay;
export const DELETE = relay;
