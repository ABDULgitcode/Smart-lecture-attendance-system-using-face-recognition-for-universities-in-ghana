import mongoose from 'mongoose';
import { config } from './config.js';

mongoose.set('strictQuery', true);

let pending;

export function ensureDb() {
  if (mongoose.connection.readyState === 1) return Promise.resolve(mongoose.connection);
  if (!pending) {
    pending = mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 8000 }).catch((error) => {
      pending = null;
      throw error;
    });
  }
  return pending;
}

export async function connectDb() {
  const waits = [500, 1000, 1500, 2500, 4000, 5000, 5000, 5000, 5000, 5000];
  let lastError;
  for (const delay of waits) {
    try {
      return await ensureDb();
    } catch (error) {
      lastError = error;
      console.log(`Waiting for MongoDB (${error.message})`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}
