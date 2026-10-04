import { MailServerDetail } from '@/components/mail-server-detail';
export default async function Page({ params }: { params: Promise<{ id: string }> }) { const { id } = await params; return <MailServerDetail id={id}/>; }
