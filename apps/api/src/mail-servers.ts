import { Body, Controller, Delete, Get, HttpException, Inject, Param, Patch, Post, Req } from '@nestjs/common';
import { mailServerFields, mailServerSchema } from '@uni/shared';
import { z } from 'zod';
import { Prisma } from '@uni/database';
import { AuthedRequest, Database, SuperAdmin, parse } from './core';

const idSchema = z.string().cuid();
const patchSchema = mailServerFields.partial().refine(value => Object.keys(value).length > 0);
const include = { _count: { select: { mailboxes: true } }, mailboxes: { select: { status: true } } } as const;

@SuperAdmin()
@Controller('mail-servers')
export class MailServersController {
  constructor(@Inject(Database) private readonly db: Database) {}
  @Get() list() { return this.db.mailServer.findMany({ orderBy: { createdAt: 'desc' }, include }); }
  @Get(':id') async get(@Param('id') rawId: string) {
    const item = await this.db.mailServer.findUnique({ where: { id: parse(idSchema, rawId) }, include: { ...include, mailboxes: { select: { id: true, email: true, status: true }, orderBy: { email: 'asc' } } } });
    if (!item) throw new HttpException({ code: 'MAIL_SERVER_NOT_FOUND', message: 'Mail server not found' }, 404);
    return item;
  }
  @Post() async create(@Body() body: unknown, @Req() request: AuthedRequest) {
    const input = parse(mailServerSchema, body);
    if (process.env.NODE_ENV === 'production' && (input.imapHost && input.imapSecurity === 'NONE' || input.smtpHost && input.smtpSecurity === 'NONE')) throw new HttpException({ code: 'INSECURE_MAIL_SERVER', message: 'Unencrypted mail connections are disabled in production' }, 400);
    const item = await this.db.mailServer.create({ data: input, include });
    await this.db.auditLog.create({ data: { userId: request.user.id, action: 'MAIL_SERVER_CREATED', entityType: 'MailServer', entityId: item.id, ipAddress: request.ip } });
    return item;
  }
  @Patch(':id') async update(@Param('id') rawId: string, @Body() body: unknown, @Req() request: AuthedRequest) {
    const id = parse(idSchema, rawId);
    const current = await this.db.mailServer.findUnique({ where: { id } });
    if (!current) throw new HttpException({ code: 'MAIL_SERVER_NOT_FOUND', message: 'Mail server not found' }, 404);
    const delta = parse(patchSchema, body);
    const input = parse(mailServerSchema, { name: current.name, providerType: current.providerType, imapHost: current.imapHost, imapPort: current.imapPort, imapSecurity: current.imapSecurity, smtpHost: current.smtpHost, smtpPort: current.smtpPort, smtpSecurity: current.smtpSecurity, smtpAuthMode: current.smtpAuthMode, status: current.status, ...delta });
    if (process.env.NODE_ENV === 'production' && (input.imapHost && input.imapSecurity === 'NONE' || input.smtpHost && input.smtpSecurity === 'NONE')) throw new HttpException({ code: 'INSECURE_MAIL_SERVER', message: 'Unencrypted mail connections are disabled in production' }, 400);
    const item = await this.db.$transaction(async tx => {
      const server = await tx.mailServer.update({ where: { id }, data: input, include });
      await tx.mailbox.updateMany({ where: { mailServerId: id }, data: { connectionConfigVersion: { increment: 1 }, status: input.status === 'DISABLED' ? 'DISABLED' : 'UNKNOWN', lastError: null } });
      await tx.auditLog.create({ data: { userId: request.user.id, action: input.status === 'DISABLED' ? 'MAIL_SERVER_DISABLED' : 'MAIL_SERVER_UPDATED', entityType: 'MailServer', entityId: id, ipAddress: request.ip } });
      return server;
    });
    return item;
  }
  @Delete(':id') async remove(@Param('id') rawId: string, @Req() request: AuthedRequest) {
    const id = parse(idSchema, rawId);
    const count = await this.db.mailbox.count({ where: { mailServerId: id } });
    if (count) throw new HttpException({ code: 'MAIL_SERVER_IN_USE', message: `Reassign ${count} mailbox${count === 1 ? '' : 'es'} before deleting this server.` }, 409);
    try {
      await this.db.$transaction(async tx => {
        await tx.mailServer.delete({ where: { id } });
        await tx.auditLog.create({ data: { userId: request.user.id, action: 'MAIL_SERVER_DELETED', entityType: 'MailServer', entityId: id, ipAddress: request.ip } });
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003') throw new HttpException({ code: 'MAIL_SERVER_IN_USE', message: 'Reassign mailboxes before deleting this server.' }, 409);
      throw error;
    }
    return { deleted: true };
  }
}
