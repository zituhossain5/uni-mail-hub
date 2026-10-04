import { OutgoingDetail } from '@/components/outgoing-mail';
export default async function Page({ params }: { params: Promise<{ id: string }> }) { const { id } = await params; return <OutgoingDetail id={id}/>; }
