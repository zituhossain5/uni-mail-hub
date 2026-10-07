export type CpanelConnectionResult = { status: string; errorCode: string | null; message: string };

export function connectionFeedback(result: CpanelConnectionResult): { notice: string; error: string } {
  return result.status === 'CONNECTED'
    ? { notice: 'cPanel connection succeeded.', error: '' }
    : { notice: '', error: `${result.errorCode ?? 'CPANEL_CONNECTION_FAILED'}: ${result.message}` };
}
