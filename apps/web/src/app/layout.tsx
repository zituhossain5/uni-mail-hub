import type { Metadata } from 'next';
import './globals.css';
import './polish.css';
import './webmail.css';
import './mail-explorer.css';
import './cpanel.css';
import './monitoring.css';
import './webhooks.css';
import './integration.css';

export const metadata: Metadata = { title: 'Uni Mail Hub', description: 'Centralized mail control for every project.' };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
