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
    await prisma.user.upsert({
      where: { email: email! },
      create: { name: name!, email: email!, passwordHash, role: UserRole.SUPER_ADMIN },
      update: { name: name!, passwordHash, role: UserRole.SUPER_ADMIN, isActive: true },
    });
    console.log(`Seeded SUPER_ADMIN: ${email}`);
  } finally {
    await prisma.$disconnect();
  }
}
seed().catch((error: unknown) => { console.error(error); process.exit(1); });
