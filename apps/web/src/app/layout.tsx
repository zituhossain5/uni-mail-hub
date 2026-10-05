import type { Metadata } from 'next';
import './globals.css';
import './polish.css';

export const metadata: Metadata = { title: 'Uni Mail Hub', description: 'Centralized mail control for every project.' };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
