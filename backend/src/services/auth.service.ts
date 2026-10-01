import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';

const prisma = new PrismaClient();

export interface CreateUserData {
  username: string;
  email: string;
  password: string;
  role?: 'admin' | 'viewer';
}

export interface LoginCredentials {
  username: string;
  password: string;
}

export interface JWTPayload {
  userId: string;
  username: string;
  email: string;
  role: string;
}

export class AuthService {
  private readonly SALT_ROUNDS = 10;
  private readonly JWT_SECRET: string;
  private readonly JWT_EXPIRES_IN: string;

  constructor() {
    this.JWT_SECRET = process.env.JWT_SECRET || 'default_secret_change_me';
    this.JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';

    if (this.JWT_SECRET === 'default_secret_change_me') {
      console.warn('⚠️  WARNING: Using default JWT secret. Set JWT_SECRET in .env for production!');
    }
  }

  async hashPassword(password: string): Promise<string> {
    return await bcrypt.hash(password, this.SALT_ROUNDS);
  }

  async comparePassword(password: string, hash: string): Promise<boolean> {
    return await bcrypt.compare(password, hash);
  }

  generateToken(payload: JWTPayload): string {
    return jwt.sign(payload, this.JWT_SECRET, {
      expiresIn: this.JWT_EXPIRES_IN
    } as jwt.SignOptions);
  }

  verifyToken(token: string): JWTPayload {
    try {
      return jwt.verify(token, this.JWT_SECRET) as JWTPayload;
    } catch (error) {
      throw new Error('Invalid or expired token');
    }
  }

  async createUser(data: CreateUserData) {
    // Check if username exists
    const existingUsername = await prisma.user.findUnique({
      where: { username: data.username }
    });

    if (existingUsername) {
      throw new Error('Username already exists');
    }

    // Check if email exists
    const existingEmail = await prisma.user.findUnique({
      where: { email: data.email }
    });

    if (existingEmail) {
      throw new Error('Email already exists');
    }

    // Hash password
    const passwordHash = await this.hashPassword(data.password);

    // Create user
    const user = await prisma.user.create({
      data: {
        username: data.username,
        email: data.email,
        passwordHash,
        role: data.role || 'admin'
      }
    });

    // Return user without password
    const { passwordHash: _, ...userWithoutPassword } = user;
    return userWithoutPassword;
  }

  async login(credentials: LoginCredentials) {
    // Find user
    const user = await prisma.user.findUnique({
      where: { username: credentials.username }
    });

    if (!user) {
      throw new Error('Invalid username or password');
    }

    // Verify password
    const isValid = await this.comparePassword(credentials.password, user.passwordHash);

    if (!isValid) {
      throw new Error('Invalid username or password');
    }

    // Update last login
    await prisma.user.update({
      where: { id: user.id },
      data: { lastLogin: new Date() }
    });

    // Generate token
    const token = this.generateToken({
      userId: user.id,
      username: user.username,
      email: user.email,
      role: user.role
    });

    // Return user and token
    const { passwordHash: _, ...userWithoutPassword } = user;
    return {
      user: userWithoutPassword,
      token
    };
  }

  async getUserById(userId: string) {
    const user = await prisma.user.findUnique({
      where: { id: userId }
    });

    if (!user) {
      return null;
    }

    const { passwordHash: _, ...userWithoutPassword } = user;
    return userWithoutPassword;
  }

  async listUsers() {
    const users = await prisma.user.findMany({
      orderBy: { createdAt: 'desc' }
    });

    return users.map(user => {
      const { passwordHash: _, ...userWithoutPassword } = user;
      return userWithoutPassword;
    });
  }

  async deleteUser(userId: string) {
    await prisma.user.delete({
      where: { id: userId }
    });

    return { success: true };
  }
}

export default new AuthService();
