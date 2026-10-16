import mongoose from 'mongoose';
import { config } from './config.js';

export async function connectDb() {
  mongoose.set('strictQuery', true);
  const waits = [500, 1000, 1500, 2500, 4000, 5000, 5000, 5000, 5000, 5000];
  let lastError;
  for (const delay of waits) {
    try {
      await mongoose.connect(config.mongoUri);
      return mongoose.connection;
    } catch (error) {
      lastError = error;
      console.log(`Waiting for MongoDB (${error.message})`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}
