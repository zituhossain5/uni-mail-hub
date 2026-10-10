import { Body, Controller, HttpException, Inject, Param, Post, Req } from '@nestjs/common';
import { z } from 'zod';
import { AuthedRequest, Database, SuperAdmin, parse } from './core';

const id = z.string().cuid();
const generated = z.object({ mailboxId: id, apiKeyId: id }).strict();

@SuperAdmin()
@Controller('projects/:projectId/integration')
export class ProjectIntegrationController {
  constructor(@Inject(Database) private readonly db: Database) {}
  @Post('config-generated')
  async configGenerated(@Param('projectId') rawProjectId: string, @Body() body: unknown, @Req() request: AuthedRequest) {
    const projectId = parse(id, rawProjectId);
    const { mailboxId, apiKeyId } = parse(generated, body);
    const grant = await this.db.apiKeyMailboxGrant.findFirst({ where: { mailboxId, apiKeyId, canSend: true, apiKey: { projectId, isActive: true, revokedAt: null }, mailbox: { projectId } }, select: { id: true } });
    if (!grant) throw new HttpException({ code: 'INTEGRATION_GRANT_REQUIRED', message: 'Select an active API key with access to this sender mailbox.' }, 409);
    await this.db.auditLog.create({ data: { userId: request.user.id, action: 'PROJECT_INTEGRATION_CONFIG_GENERATED', entityType: 'Project', entityId: projectId, ipAddress: request.ip, metadata: { mailboxId, apiKeyId } } });
    return { recorded: true };
  }
}
