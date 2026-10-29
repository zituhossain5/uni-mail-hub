import type { Metadata } from 'next';
import './globals.css';
import './polish.css';
import './webmail.css';
import './mail-explorer.css';
import './cpanel.css';
import './monitoring.css';
import './webhooks.css';
import './integration.css';
import './lavender.css';
import './inbox.css';
import './composer.css';
import { AppearanceProvider } from '@/components/appearance';
import { appearanceBootstrap } from '@/lib/appearance';

export const metadata: Metadata = { title: 'Uni Mail Hub', description: 'Centralized mail control for every project.' };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en" data-theme="lavender" data-motion="full" suppressHydrationWarning><body><script dangerouslySetInnerHTML={{ __html: appearanceBootstrap }}/><AppearanceProvider>{children}</AppearanceProvider></body></html>;
}
