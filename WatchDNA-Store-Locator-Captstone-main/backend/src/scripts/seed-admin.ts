#!/usr/bin/env ts-node
import authService from '../services/auth.service';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

function requireSeedPassword(): string {
  const password = process.env.ADMIN_SEED_PASSWORD?.trim();
  if (!password || password.length < 6) {
    console.error(
      '\n❌ ADMIN_SEED_PASSWORD is required (min 6 characters).\n' +
        '   Example: ADMIN_SEED_PASSWORD="$(openssl rand -base64 24)" npm run seed-admin\n' +
        '   For an interactive prompt, use: npm run create-admin\n\n'
    );
    process.exit(1);
  }
  return password;
}

async function seedAdmin() {
  console.log('\n🔐 Creating admin user from environment...\n');

  const username = (process.env.ADMIN_SEED_USERNAME || 'admin').trim();
  const email = (process.env.ADMIN_SEED_EMAIL || 'admin@watchdna.com').trim();
  const password = requireSeedPassword();

  try {
    const user = await authService.createUser({
      username,
      email,
      password,
      role: 'admin'
    });

    console.log('✅ Admin user created successfully!\n');
    console.log('─'.repeat(40));
    console.log(`Username: ${user.username}`);
    console.log(`Email:    ${user.email}`);
    console.log(`Role:     ${user.role}`);
    console.log('─'.repeat(40));
    console.log('\n⚠️  Password was set from ADMIN_SEED_PASSWORD; clear it from your shell history if needed.\n');

  } catch (error: any) {
    if (error.message.includes('already exists')) {
      console.log('✅ Admin user already exists (same username or email).\n');
    } else {
      console.error(`❌ Error: ${error.message}\n`);
      process.exit(1);
    }
  }

  process.exit(0);
}

seedAdmin();
