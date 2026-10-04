import { MailboxDetail } from '@/components/mailbox-detail';
export default async function Page({ params }: { params: Promise<{ id: string }> }) { const { id } = await params; return <MailboxDetail id={id}/>; }
