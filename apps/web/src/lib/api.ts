import { cookies } from 'next/headers';

export async function apiGet<T>(path: string): Promise<T | null> {
  const token = (await cookies()).get('umh_session')?.value;
  if (!token) return null;
  const base = process.env.API_URL;
  if (!base) throw new Error('API_URL is required');
  try {
    const response = await fetch(`${base}/api/v1/${path}`, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' });
    return response.ok ? (await response.json() as T) : null;
  } catch { return null; }
}
