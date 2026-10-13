import bcrypt from 'bcrypt';
import { BCRYPT_ROUNDS } from '../constants/auth.js';

export const hashPassword = async (plain: string): Promise<string> => {
    return bcrypt.hash(plain, BCRYPT_ROUNDS);
};

export const verifyPassword = async (plain: string, hash: string): Promise<boolean> => {
    return bcrypt.compare(plain, hash);
};
