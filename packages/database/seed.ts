import { PrismaClient, UserRole } from './generated/client';
import argon2 from 'argon2';

const email = process.env.SEED_ADMIN_EMAIL?.trim().toLowerCase();
const password = process.env.SEED_ADMIN_PASSWORD;
const name = process.env.SEED_ADMIN_NAME?.trim();
if (!email || !name || !password || password.length < 12) {
  throw new Error('Set SEED_ADMIN_NAME, SEED_ADMIN_EMAIL, and a password of at least 12 characters in .env.');
}
async function seed() {
  const prisma = new PrismaClient();
  try {
    const passwordHash = await argon2.hash(password!);
    await prisma.$transaction(async tx => {
      const user = await tx.user.upsert({
        where: { email: email! },
        create: { name: name!, email: email!, passwordHash, role: UserRole.SUPER_ADMIN },
        update: { name: name!, passwordHash, role: UserRole.SUPER_ADMIN, isActive: true },
      });
      await tx.userSession.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } });
      await tx.auditLog.create({ data: { userId: user.id, action: 'ADMIN_PASSWORD_SEEDED', entityType: 'User', entityId: user.id } });
    });
    console.log(`Seeded SUPER_ADMIN: ${email}`);
  } finally {
    await prisma.$disconnect();
  }
}
seed().catch((error: unknown) => { console.error(error); process.exit(1); });
