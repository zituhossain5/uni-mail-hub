import { cookies } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';
import { allowedRequestOrigin } from '@/lib/request-origin';

async function relay(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  if (request.method !== 'GET' && !allowedRequestOrigin(request, process.env.WEB_URL, process.env.NODE_ENV)) return NextResponse.json({ statusCode: 403, code: 'BAD_ORIGIN', message: 'Invalid origin' }, { status: 403 });
  const api = process.env.API_URL;
  if (!api) return NextResponse.json({ statusCode: 503, code: 'CONFIG_ERROR', message: 'API_URL is missing' }, { status: 503 });
  const cookieStore = await cookies();
  const token = cookieStore.get('umh_session')?.value;
  const isLogin = path.join('/') === 'auth/login';
  const isLogout = path.join('/') === 'auth/logout';
  const isInvitation = path[0] === 'invitations' && path.length === 2 && (path[1] === 'inspect' || path[1] === 'accept') && request.method === 'POST';
  if (isLogout && !token) return NextResponse.json({ success: true });
  if (!isLogin && !isInvitation && !token) return NextResponse.json({ statusCode: 401, code: 'UNAUTHORIZED', message: 'Sign in required' }, { status: 401 });
  try {
    const maxBodyBytes = request.method === 'POST' && ['admin/compose','messages'].includes(path.join('/')) ? 30 * 1024 * 1024 : 2 * 1024 * 1024;
    const oversized = () => NextResponse.json({ statusCode: 413, code: 'PAYLOAD_TOO_LARGE', message: 'Request too large' }, { status: 413 });
    if (Number(request.headers.get('content-length')) > maxBodyBytes) return oversized();
    let body: string | undefined;
    if (request.method !== 'GET' && request.method !== 'HEAD' && request.body) {
      const reader = request.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBodyBytes) { await reader.cancel(); return oversized(); }
        chunks.push(value);
      }
      body = Buffer.concat(chunks).toString('utf8');
    }
    const upstream = await fetch(`${api}/api/v1/${path.map(encodeURIComponent).join('/')}${request.nextUrl.search}`, {
      method: request.method,
      headers: { 'Content-Type': 'application/json', ...(token && !isLogin && !isInvitation ? { Authorization: `Bearer ${token}` } : {}), ...(request.headers.get('idempotency-key') ? { 'Idempotency-Key': request.headers.get('idempotency-key')! } : {}), ...(process.env.NODE_ENV === 'production' && request.headers.get('x-forwarded-for') ? { 'X-Forwarded-For': request.headers.get('x-forwarded-for')! } : {}) },
      body,
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
    if (isLogout) {
      const response = NextResponse.json({ success: upstream.ok }, { status: upstream.ok ? 200 : upstream.status, headers: { 'Cache-Control': 'private, no-store' } });
      response.cookies.delete('umh_session');
      return response;
    }
    if (isLogin && upstream.ok && typeof data === 'object' && data !== null && 'token' in data && typeof data.token === 'string') {
      const response = NextResponse.json({ user: 'user' in data ? data.user : null }, { headers: { 'Cache-Control': 'private, no-store' } });
      response.cookies.set('umh_session', data.token, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/', maxAge: 8 * 60 * 60 });
      return response;
    }
    return NextResponse.json(data, { status: upstream.status, headers: { 'Cache-Control': 'private, no-store' } });
  } catch {
    return NextResponse.json({ statusCode: 503, code: 'API_UNAVAILABLE', message: 'API is unavailable' }, { status: 503 });
  }
}
export const GET = relay;
export const POST = relay;
export const PATCH = relay;
export const PUT = relay;
export const DELETE = relay;
