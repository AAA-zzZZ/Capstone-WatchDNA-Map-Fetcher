#!/usr/bin/env ts-node
import * as readline from 'readline';
import authService from '../services/auth.service';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function question(query: string): Promise<string> {
  return new Promise(resolve => {
    rl.question(query, resolve);
  });
}

async function createAdmin() {
  console.log('\n🔐 Create Admin User\n');
  console.log('─'.repeat(40));

  try {
    const username = await question('Username: ');
    const email = await question('Email: ');
    const password = await question('Password (min 6 chars): ');
    const confirmPassword = await question('Confirm Password: ');
    const roleInput = await question('Role (admin/viewer) [admin]: ');

    // Validation
    if (!username || !email || !password) {
      console.error('\n❌ Username, email, and password are required');
      process.exit(1);
    }

    if (password !== confirmPassword) {
      console.error('\n❌ Passwords do not match');
      process.exit(1);
    }

    if (password.length < 6) {
      console.error('\n❌ Password must be at least 6 characters');
      process.exit(1);
    }

    const role = roleInput.toLowerCase() === 'viewer' ? 'viewer' : 'admin';

    // Create user
    console.log('\n⏳ Creating user...');

    const user = await authService.createUser({
      username,
      email,
      password,
      role
    });

    console.log('\n✅ User created successfully!\n');
    console.log('─'.repeat(40));
    console.log(`ID:       ${user.id}`);
    console.log(`Username: ${user.username}`);
    console.log(`Email:    ${user.email}`);
    console.log(`Role:     ${user.role}`);
    console.log('─'.repeat(40));
    console.log('\nYou can now login with these credentials.\n');

  } catch (error: any) {
    console.error(`\n❌ Error: ${error.message}\n`);
    process.exit(1);
  } finally {
    rl.close();
    process.exit(0);
  }
}

createAdmin();
